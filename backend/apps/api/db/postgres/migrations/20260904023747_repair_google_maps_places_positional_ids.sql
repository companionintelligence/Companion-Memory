-- migrate:up
-- Re-key every google_maps_places row whose `source_id` was derived from the
-- PARSE INDEX (`gmaps:review:0`, `gmaps:place:2`) onto the content-derived key
-- datasources/google_maps_places.ts now emits, in place.
--
-- ## Why this migration has to exist
--
-- SRC-06 moved both lanes off the parse index. `source_id` IS the destination's
-- unique key -- `content_source_identity_uniq` and `events_source_identity_uniq`
-- are both `(user_id, source_system, source_id)` -- so that change moves the
-- identity of every row already stored under an index-derived id.
--
-- Nothing converges those rows on its own. `INGEST_REFRESH_COLUMNS.content` and
-- `.event` are BOTH `[]`, i.e. find-or-return: the conflict action is DO
-- NOTHING, not DO UPDATE. So the next import does not update the old row, it
-- INSERTS a second one beside it, and nothing will ever emit the old id again
-- to reconcile the pair. Doing nothing here is therefore not "leave it alone",
-- it is "every affected record is permanently duplicated the next time the user
-- imports" -- the same trap 20260821025524 (google_voice copy index) was
-- written for, stated there as: leaving the rows is strictly worse than doing
-- nothing.
--
-- Measured on the reference appliance before this was written:
--
--   ci.content   gmaps:review:<n>   67 rows  (reviews route to content alone)
--   ci.events    gmaps:place:<n>    18 rows  (cid-less saved places)
--   ci.events    gmaps:place:<sha>   5 rows  (labeled places, the old sha1 key)
--   ci.events    gmaps:place:<cid>   8 rows  (untouched -- see below)
--
--   ci_search.vectors     85 rows, one per affected row
--   ci_search.embeddings  85 rows, one per affected row
--
-- ## Why UPDATE and not DELETE, and why not merge_candidates
--
-- DELETE is what 20260821025524 did, but it could only do that because every
-- row it removed had a surviving twin from the same run ("nothing unique is
-- lost"). These rows have no twin: deleting them would drop 85 memories on the
-- floor and rely on the user re-importing a Takeout they may no longer have.
-- A fix whose whole purpose is to stop silent loss must not open with some.
--
-- An in-place UPDATE keeps the row, so it also keeps its uuid -- and
-- ci_search.vectors / ci_search.embeddings are keyed `(entity_type, entity_id)`
-- on that uuid, not on `source_id`. Re-keying therefore leaves NO stale index
-- rows behind and needs no ci_search maintenance at all for the rows it keeps.
-- (Deleting would have needed it: OrphanCleanupService reaps an index row only
-- when its source row is gone, so index rows for rows we removed would answer
-- searches until something deleted them explicitly.)
--
-- `ci.merge_candidates` is not an option: it is Person/Item only. Both
-- producers (DuplicateDetectStage `CANDIDATE_ENTITY_TYPE = 'Person'`,
-- ObjectDuplicateDetectStage `'Item'`) and the review path
-- (MergeCandidateService, which hydrates `people`) are typed to those two, and
-- the live table holds nothing else. Content and Event rows are outside that
-- machinery entirely, so there is no dedup lane to hand this to.
--
-- ## How the new key is recomputed here
--
-- Exactly as the parser computes it -- `contentKey` in
-- datasources/google_maps_places.ts, which was constrained to make this
-- possible:
--
--   * sha256, because it is a core Postgres function; the previous sha1 lives
--     only in pgcrypto's digest(), which this schema does not install.
--   * chr(31) (U+001F) as the field separator, because Postgres TEXT cannot
--     hold a NUL byte -- `chr(0)` raises -- so a NUL-joined key is unmigratable
--     by construction.
--   * only fields the destination row stores. The review key's raw `date` had
--     to go: Takeout writes it at microsecond precision
--     (2025-01-26T23:47:37.122457Z), `new Date()` truncates to milliseconds,
--     and ci.content has no time column at all, so the exact string exists
--     nowhere to hash.
--   * coordinates via to_char(round(x::numeric, 7), 'FM9990.0000000'), which
--     matches JS `toFixed(7)` including trailing zeros. Verified digit-for-digit
--     against all 12 coordinate-bearing google_maps_places events on the
--     reference appliance (33.5146950, 41.8931400, -87.6256850, -118.4483020 --
--     the trailing-zero cases FM would otherwise have trimmed).
--
-- Scoped by SHAPE, not by run: it recomputes the key for every non-cid
-- google_maps_places row from that row's own stored fields, so it is idempotent
-- (an already-correct row is updated to the value it already has and filtered
-- out) and it does not care which of the historical key schemes a row is
-- wearing -- parse index, or the sha1 labeled-place key that predates SRC-06.
--
-- Rows keyed on a Google `cid` are deliberately untouched: the cid is a real
-- place id, the parser still prefers it, and their identity has never moved.
-- The test is the row's own stored URL rather than the id's shape, which is
-- exact -- a cid and a hash are not otherwise reliably distinguishable.
--
-- `metadata.contentHash` keeps the id the import actually emitted. That is
-- provenance of the run, nothing reads it (inputs.ts writes it; no reader
-- exists), and rewriting it would falsify the ledger.

-- ---------------------------------------------------------------- reviews --

CREATE TEMP TABLE gmaps_rekey_content ON COMMIT DROP AS
SELECT c.id,
       c.user_id,
       c.source_id AS old_source_id,
       'gmaps:review:'
         || encode(
              sha256(
                convert_to(
                  concat_ws(
                    chr(31),
                    coalesce(c.source_data ->> 'Name', ''),
                    coalesce(c.source_data ->> 'Address', ''),
                    coalesce(c.source_data ->> 'URL', ''),
                    coalesce(c.source_data ->> 'Rating', ''),
                    coalesce(c.source_data ->> 'Text', '')
                  ),
                  'UTF8'
                )
              ),
              'hex'
            ) AS new_source_id,
       c.created_at
  FROM ci.content c
 WHERE c.source_system = 'google_maps_places'
   AND c.source_id LIKE 'gmaps:review:%';

-- Two old rows can land on one new key: that is the SRC-06 defect itself (two
-- Takeouts in one inbox unit both emitted gmaps:review:0,1,2...), and those
-- rows always were one review. Keep one and drop the rest, preferring a row
-- that already carries the correct key -- so a user who re-imported after the
-- parser fix keeps the row the new pipeline wrote -- then the oldest.
CREATE TEMP TABLE gmaps_content_losers ON COMMIT DROP AS
SELECT id
  FROM (SELECT id,
               row_number() OVER (
                 PARTITION BY user_id, new_source_id
                 ORDER BY (old_source_id = new_source_id) DESC, created_at, id
               ) AS rn
          FROM gmaps_rekey_content) ranked
 WHERE rn > 1;

DELETE FROM ci_search.vectors v
 USING gmaps_content_losers l
 WHERE v.entity_type = 'content'
   AND v.entity_id = l.id;

DELETE FROM ci_search.embeddings e
 USING gmaps_content_losers l
 WHERE e.entity_type = 'content'
   AND e.entity_id = l.id;

-- ci.content.id FKs ci.entities(entity_id, entity_type) ON DELETE CASCADE, so
-- the entity row is the one to remove -- same shape as 20260821025524.
DELETE FROM ci.entities en
 USING gmaps_content_losers l
 WHERE en.entity_id = l.id
   AND en.entity_type = 'Content';

UPDATE ci.content c
   SET source_id = r.new_source_id,
       updated_at = now()
  FROM gmaps_rekey_content r
 WHERE c.id = r.id
   AND c.source_id IS DISTINCT FROM r.new_source_id;

-- ----------------------------------------------------------------- places --

CREATE TEMP TABLE gmaps_rekey_events ON COMMIT DROP AS
SELECT e.event_id AS id,
       e.user_id,
       e.source_id AS old_source_id,
       'gmaps:place:'
         || encode(
              sha256(
                convert_to(
                  concat_ws(
                    chr(31),
                    coalesce(e.metadata ->> 'Name', ''),
                    coalesce(e.metadata ->> 'Address', ''),
                    coalesce(e.metadata ->> 'URL', ''),
                    coalesce(
                      to_char(round(ST_Y(e.location_coordinates::geometry)::numeric, 7),
                              'FM9990.0000000'),
                      ''
                    ),
                    coalesce(
                      to_char(round(ST_X(e.location_coordinates::geometry)::numeric, 7),
                              'FM9990.0000000'),
                      ''
                    )
                  ),
                  'UTF8'
                )
              ),
              'hex'
            ) AS new_source_id,
       e.created_at
  FROM ci.events e
 WHERE e.source_system = 'google_maps_places'
   AND e.source_id LIKE 'gmaps:place:%'
   AND coalesce(e.metadata ->> 'URL', '') !~ '[?&]cid=[0-9]+';

CREATE TEMP TABLE gmaps_event_losers ON COMMIT DROP AS
SELECT id
  FROM (SELECT id,
               row_number() OVER (
                 PARTITION BY user_id, new_source_id
                 ORDER BY (old_source_id = new_source_id) DESC, created_at, id
               ) AS rn
          FROM gmaps_rekey_events) ranked
 WHERE rn > 1;

DELETE FROM ci_search.vectors v
 USING gmaps_event_losers l
 WHERE v.entity_type = 'event'
   AND v.entity_id = l.id;

DELETE FROM ci_search.embeddings e
 USING gmaps_event_losers l
 WHERE e.entity_type = 'event'
   AND e.entity_id = l.id;

DELETE FROM ci.entities en
 USING gmaps_event_losers l
 WHERE en.entity_id = l.id
   AND en.entity_type = 'Event';

UPDATE ci.events e
   SET source_id = r.new_source_id,
       updated_at = now()
  FROM gmaps_rekey_events r
 WHERE e.event_id = r.id
   AND e.source_id IS DISTINCT FROM r.new_source_id;

-- migrate:down
-- No-op: irreversible, same reasoning as the other repair migrations here.
--
-- The parse index a row used to carry is not recoverable from the row -- it was
-- a position in a file this database does not have, and for ci.content nothing
-- retained it (ci.events keeps the emitted id in `metadata.contentHash`, but
-- content does not, so a partial rollback would be worse than none). Rolling
-- the code back would in any case re-emit index-derived ids on the next import
-- and re-open the defect.
