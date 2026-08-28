-- migrate:up
-- Repair the rows that wear the IMPORT WALL CLOCK as if it were the moment
-- something happened.
--
-- The user-visible shape on this appliance: five Google Maps saved places --
-- "Home", "Work", "Gym", "Gheric", "I've" -- sitting at the TOP of the timeline,
-- all five sharing one `start_time` of 2026-08-21T04:56:01.296Z, which is the
-- instant the run parsed `Labeled places.json`. A saved place is a bookmark. It
-- never happened at a time, and dating it "now" makes it dominate the
-- most-recent view and poisons anything that reasons over time.
--
-- Three tables carry the damage, and they do NOT get the same treatment,
-- because they do not have the same ability to tell the truth:
--
--   ci.events            5 rows  -> MARKED. `start_time` is NOT NULL and there
--                                  is no date to recover, but the table has
--                                  `time_source` / `time_precision`, so the row
--                                  can say the instant is not evidence. The
--                                  instant itself is left EXACTLY as it is.
--   ci.position          1 row   -> DELETED. A position row's entire content is
--                                  "the user's body was at (lat, lon) AT TIME
--                                  T". There is no time_source column and `time`
--                                  is the hypertable partition key, so there is
--                                  no honest degraded form. The one row here
--                                  asserts the user was at their gym at
--                                  04:56 in the morning.
--   ci.browser_activity  1 row   -> DELETED. Same argument: "visited X at time
--                                  T", `time` NOT NULL, no provenance column.
--
-- ## Why a migration is REQUIRED even though the producer is fixed
--
-- This directory's hard-won rule is that a repair whose MINTER still produces
-- the bad value is undone by the next import. The minter IS fixed in the same
-- commit -- push/canonical.ts no longer routes an undated record to
-- ci.position or ci.browser_activity, push/inputs.ts stamps
-- time_source='ingest' at insert, and datasources/nmea.ts stopped filling a
-- dateless GGA sentence in with today's date. But the converse also holds here,
-- and it is why the migration cannot be skipped:
--
--   INGEST_REFRESH_COLUMNS.event is `[]`
--
-- so re-ingesting an existing provenance triple is find-or-RETURN, not update.
-- The five saved-place rows already exist; a re-import will never write the new
-- marker onto them. The producer fix protects future rows and only future rows.
-- (The two ci.position / ci.browser_activity rows are the opposite case: the
-- producer will simply not re-create them, so deleting is permanent.)
--
-- ## The predicate: exact, not heuristic
--
-- `ci_import.staged_items` is still on disk and holds the parser's own verdict:
-- `occurred_at IS NULL` means THE SOURCE GAVE NO TIME. That is the same fact
-- push/canonical.ts turns into `dated: false`, and `content_hash` is the
-- `source_id` every destination row carries (canonical.ts sourceIdFor), so the
-- staged row and the ingested row join on (user_id, data_source, content_hash)
-- with no guessing.
--
-- The alternative -- the `events-timestamped-at-import` doctor check's
-- structural arm, `start_time BETWEEN created_at ± 2 seconds` -- was rejected.
-- It has both error directions here: it MISSES all five saved places (their
-- events were committed ~10 minutes after the parse, so created_at is nowhere
-- near start_time) and it would CATCH a live capture ingested the second it was
-- recorded, which is a legitimate row.
--
-- ## Measured on this appliance before writing the migration
--
--   WITH undated AS (
--     SELECT DISTINCT user_id, data_source AS source_system, content_hash AS source_id
--       FROM ci_import.staged_items WHERE occurred_at IS NULL)
--   ...join each table on the triple...
--
--   ci.browser_activity | instagram          | 1 row
--   ci.events           | google_maps_places | 5 rows  (0 already marked)
--   ci.events           | reddit             | 2 rows  (2 already marked)
--   ci.position         | google_maps_places | 1 row
--
-- Staged undated totals for context, and why they do NOT all appear above --
-- the routing already refused most of them a timed home:
--   vcard 5424 (contact.card routes to NO destination), claude 5 (content),
--   google_maps_places 5, reddit 3, instagram 1.
--
-- The two reddit rows are `moderated_subreddit` affiliations. They are ALREADY
-- time_source='ingest' because TemporalRepairStage's declared SourceTimeSpec
-- covers them -- which is precisely the "labelled, but the minter is still
-- live" state a prior audit reported. The UPDATE below is a no-op on
-- time_source for those two and still adds `metadata.undated`, so the marker
-- reaches the field the read path already exposes.
--
-- ## Idempotent
--
-- Every statement recomputes the same join. A second run marks the same rows
-- with the same values and deletes nothing (the rows are gone).

-- ---------------------------------------------------------------------------
-- 1. ci.events -- mark, do not move. The instant stays; the claim goes.
-- ---------------------------------------------------------------------------
WITH undated AS (
  SELECT DISTINCT s.user_id, s.data_source AS source_system, s.content_hash AS source_id
    FROM ci_import.staged_items s
   WHERE s.occurred_at IS NULL
)
UPDATE ci.events e
   SET time_source    = 'ingest',
       time_precision = 'unknown',
       -- `undated` on metadata as well as on the columns: EventType.metadata is
       -- already a GraphQLJSONObject on the wire, so a client can render "date
       -- unknown" from it today; time_source has no GraphQL field yet. Matches
       -- what push/inputs.ts toEventInput now stamps at insert.
       metadata       = coalesce(e.metadata, '{}'::jsonb) || '{"undated": true}'::jsonb,
       updated_at     = now()
  FROM undated u
 WHERE e.source_type   = 'ci-import-tools'
   AND e.user_id       = u.user_id
   AND e.source_system = u.source_system
   AND e.source_id     = u.source_id
   -- Skip rows already in the target state so a re-run does not churn
   -- updated_at (which the clean stage's own bookkeeping reads).
   AND ( e.time_source IS DISTINCT FROM 'ingest'
      OR e.time_precision IS DISTINCT FROM 'unknown'
      OR coalesce(e.metadata->>'undated', '') <> 'true' );

-- ---------------------------------------------------------------------------
-- 2. ci.position -- delete. A fix with no time is not a low-confidence fix.
--
-- These are LocationEstimateService's primary donors: it prefers position rows
-- with a small accuracy_meters when inferring where an un-geotagged event
-- happened, so one invented fix does not merely display wrong, it drags every
-- neighbouring inference toward a place the user was not, at a time they were
-- not there.
--
-- Nothing is lost from the map: the saved place's ci.events row keeps its
-- location_coordinates and is what draws the pin.
-- ---------------------------------------------------------------------------
WITH undated AS (
  SELECT DISTINCT s.user_id, s.data_source AS source_system, s.content_hash AS source_id
    FROM ci_import.staged_items s
   WHERE s.occurred_at IS NULL
)
DELETE FROM ci.position p
 USING undated u
 WHERE p.source_type   = 'ci-import-tools'
   AND p.user_id       = u.user_id
   AND p.source_system = u.source_system
   AND p.source_id     = u.source_id;

-- ---------------------------------------------------------------------------
-- 3. ci.browser_activity -- delete, for the same reason.
--
-- The live row is Instagram's `shopping/recently_viewed_items.html` entry,
-- which carries no date in the export at all -- and no URL either; verified
-- against ci_import.staged_items (content_hash
-- 'instagram:recently_viewed_items.html#0'): the entry's metadata has no url
-- key, only Title/Type/Source/Description (Meta never links a viewed product
-- to a page). Its title survives: the fixed router now sends an undated
-- browsing action to ci.content typed 'bookmark' with no url, so a re-import
-- repopulates it there rather than here.
--
-- ci_search rows are keyed by entity id and browser_activity is not a
-- ci.entities subtype (no entity_id, no search index rows), so unlike the
-- ci.content cleanups in this directory there is nothing to hand-clean
-- alongside. Verified: ci_search.vectors / ci_search.embeddings hold no
-- entity_type = 'browser_activity' rows.
-- ---------------------------------------------------------------------------
WITH undated AS (
  SELECT DISTINCT s.user_id, s.data_source AS source_system, s.content_hash AS source_id
    FROM ci_import.staged_items s
   WHERE s.occurred_at IS NULL
)
DELETE FROM ci.browser_activity b
 USING undated u
 WHERE b.source_type   = 'ci-import-tools'
   AND b.user_id       = u.user_id
   AND b.source_system = u.source_system
   AND b.source_id     = u.source_id;

-- ## Verify after applying
--
-- Should be 7 (5 saved places + 2 reddit affiliations), all marked:
--   SELECT source_system, count(*) FROM ci.events
--    WHERE time_source = 'ingest' AND metadata->>'undated' = 'true'
--    GROUP BY 1;
--
-- Should be 0 in both:
--   WITH undated AS (SELECT DISTINCT user_id, data_source AS ss, content_hash AS sid
--                      FROM ci_import.staged_items WHERE occurred_at IS NULL)
--   SELECT (SELECT count(*) FROM ci.position p JOIN undated u
--             ON p.user_id=u.user_id AND p.source_system=u.ss AND p.source_id=u.sid),
--          (SELECT count(*) FROM ci.browser_activity b JOIN undated u
--             ON b.user_id=u.user_id AND b.source_system=u.ss AND b.source_id=u.sid);
--
-- start_time on the five saved places must be UNCHANGED -- this migration marks,
-- it does not move:
--   SELECT metadata->>'Title', start_time FROM ci.events
--    WHERE source_system = 'google_maps_places' AND metadata->>'Kind' = 'labeled_place';

-- migrate:down
-- Partially reversible, and only the marking half.
--
-- The two DELETEs are not undoable: nothing records which rows were removed
-- versus already absent, and the fabricated instants they carried were never
-- worth restoring. Re-importing the export is the forward path -- and with the
-- producer fixed those rows do not come back, which is the point.
--
-- The UPDATE is reversed below by clearing the markers on exactly the same
-- join. One honest caveat: two of the seven rows (the reddit affiliations) were
-- already time_source='ingest' before this migration ran, written by
-- TemporalRepairStage, and this down-migration clears those too. It is not a
-- data loss -- the stage re-establishes them on its next sweep, since its
-- candidate predicate deliberately does NOT filter on its own output.
WITH undated AS (
  SELECT DISTINCT s.user_id, s.data_source AS source_system, s.content_hash AS source_id
    FROM ci_import.staged_items s
   WHERE s.occurred_at IS NULL
)
UPDATE ci.events e
   SET time_source    = NULL,
       time_precision = NULL,
       metadata       = coalesce(e.metadata, '{}'::jsonb) - 'undated',
       updated_at     = now()
  FROM undated u
 WHERE e.source_type   = 'ci-import-tools'
   AND e.user_id       = u.user_id
   AND e.source_system = u.source_system
   AND e.source_id     = u.source_id;
