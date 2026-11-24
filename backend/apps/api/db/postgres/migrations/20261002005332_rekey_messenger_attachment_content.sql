-- migrate:up
-- Move the Messenger attachments catalogued before #2912 onto the system their
-- message is keyed under, in place.
--
-- ## What #2912 changed, and what it left behind
--
-- MediaStage catalogues each photo or video a Messenger message carried as a
-- `ci.content` row keyed on the message's own identity: `attachmentIdentity`
-- gives `attachment:<message source_id>:<sha256 of the bytes>`, and a store
-- that returned no hash falls back to `<message source_id>:attachment:<index>`
-- (`attachmentContentInput` in import/stages/MediaStage.ts). Until #2912 the
-- SYSTEM half of that key was the staged row's data source, `facebook`, while
-- `toFacebookMessengerCommunicationInput` keys the message itself under
-- `facebook_messenger`. Every Messenger attachment therefore answered the
-- Facebook source filter while its own message did not. #2912 keys new rows
-- under the message's system and shipped no data migration, so every row
-- written before it still says `facebook`.
--
-- Such a row sits under a key nothing emits any more, and the next import of
-- the same archive does not find it. `content_source_identity_uniq` is
-- `(user_id, source_system, source_id)`, so a re-import INSERTS a second row
-- beside it, with the same source_id and the same stored file. Measured on the
-- upgraded reference corpus (13,438 files, 104,931 content, 327,168 messages)
-- after `ci inbox --start --only facebook`: content +1 and entities +1 (a new
-- graph node), messages, events, files and edges unchanged, and the message's
-- `attachments` still naming the OLD row (`attachments` is not in
-- INGEST_REFRESH_COLUMNS.communication, so a re-import never rewrites it). The
-- photo then shows twice, once under Facebook and once under Facebook Messenger.
--
-- ## What this does
--
-- 1. Finds every Messenger attachment row, under either system, BY ITS
--    MESSAGE: same user, the message under `facebook_messenger`, the message's
--    source_id equal to the parent part of the row's id. Both id shapes:
--      attachment:<message source_id>:<64 hex>   (the bytes' sha256)
--      <message source_id>:attachment:<n>        (no-hash fallback)
--    The message is what proves Messenger. The id shape alone only says
--    "an attachment of some Facebook record", and an attachment whose message
--    is gone, or belongs to another user, is left as it is.
--
-- 2. Resolves the TWINS a re-import after upgrading wrote: a `facebook` row and
--    a `facebook_messenger` row with the same user and source_id. One must go
--    before the other can be re-keyed, or the UPDATE below collides on
--    `content_source_identity_uniq`. The one the message's `attachments` names
--    is kept: that is the row the message, and the ATTACHED_TO edge projected
--    from it, already point at. When it names neither or both, the `facebook`
--    row is kept: it is the older one, and the one later state accumulated on.
--    The corpus's twin pair shows the difference: the old row had a renamed
--    title (a `ContentService.update` delta) and the message's edge, the new
--    one had neither. When the message names both, the loser's entry is
--    dropped from its `attachments` so it names no deleted row.
--
-- 3. Deletes each loser through the SQL equivalent of `teardownContent`
--    (memory/services/contentPurge.ts), the teardown the purge path uses:
--    `clearHbpeLinks` (HBPE's links, each taken off its cluster's
--    member_count), `deleteBareReferences` with CONTENT_REFERENCES (edges in
--    both directions and their deltas, ledger rows, pipeline state and dead
--    letters, the node's deltas, tags, categories, search vectors, embeddings
--    and skips), then the `Content` base row, whose ON DELETE CASCADE takes
--    the `ci.content` row with it.
--
--    `clearHbpeLinks` locks the rows first, so that a live HBPE labeller
--    cannot add a link between the clear and the delete. Nothing labels while
--    migrations run (the API, HBPE's only scheduler, starts after
--    `setup-database` has exited), so that lock is left out. Like the purge,
--    this leaves alone the records that only MENTION content by id
--    (`receipts.document_content_id`, `object_observations.content_id` /
--    `crop_content_id`, `product_models.image_content_id` /
--    `manual_content_ids`); on the corpus none of those columns is set on ANY
--    content row. The stored file is not touched: its sha256 is in the id, so
--    both rows wrap the same `ci.files` row, which the survivor still wraps.
--
-- 4. Re-keys every surviving `facebook` row IN PLACE, so its id, and every
--    reference to it, stays valid: the message's `attachments`, the graph
--    node and its edges, the search rows, HBPE's labels. Two places hold the
--    system, and the two Facebook filters read different ones:
--      ci.content.source_system   the explorer's How filter
--                                 (getEntitiesForContents `connectors`)
--      ci.record_sources.platform the content library's filter and facet,
--                                 which read the ledger FIRST
--                                 (effectiveSourceSystemSql), falling back to
--                                 the column only for an unledgered row
--    so the ledger rows that recorded the old identity are re-keyed too,
--    `source_system` and `platform` both (ledgerPlatform of a platform system
--    is the system itself). Re-keying the column alone would leave the photo
--    under Facebook in the library.
--
--    `updated_at` is deliberately NOT bumped. The explorer's chronological
--    browse places content by `updated_at` (getEntitiesForContents orders and
--    windows on it), and the summary sidecar picks content by
--    GREATEST(created_at, updated_at), so a bump would move every repaired photo
--    to the day this ran. A label correction is not a content change.
--
-- ## Why the search index is not re-armed
--
-- `ci_search.vectors` / `.embeddings` are keyed `(entity_type, entity_id)` on
-- the uuid, which the in-place re-key keeps, and a content row's search text
-- carries no source system: `loadContentRows` reads title, text, type, url and
-- mimetype into `contentWeightedTexts` / `contentSearchDocument`
-- (search-ingress/searchTexts.ts). Unlike an event's document, which carries
-- `sourceSystemSearchTokens`, nothing indexed for content changes, so there
-- are no `ci.pipeline_state` rows to delete. The facets and both filters read
-- the live columns. HBPE reads no `source_system`.
--
-- ## Dry run
--
-- BEGIN ... ROLLBACK on a pg_dump copy of the upgraded and re-imported
-- reference corpus (13,438 files, 104,932 content, 327,168 messages), then
-- applied for real through dbmate as `companion` (0.86 s). Statements in file
-- order:
--   working set   2 rows: the `facebook` row and its `facebook_messenger`
--                 twin, one message
--   twins         1 pair; the `facebook` row kept (the message names it)
--   attachments   0 messages rewritten
--   teardown      HBPE 0, edges 0, ledger 1, pipeline_state 2, dead letters 0,
--                 deltas 1, tags 0, categories 0, vectors 1, embeddings 1,
--                 skips 0, then 1 node (and its content row)
--   re-key        1 content row; ledger: 0 stale, 0 redundant, 1 re-keyed
--                 (`platform` facebook -> facebook_messenger)
-- Afterwards: content 104,931; Messenger attachments under `facebook` 0, in
-- the column and in the ledger; messages naming a missing content id 0; the
-- Facebook filter returns 0 of them in the explorer and the library (1 each
-- before), Facebook Messenger 1 (the survivor, still named by its message,
-- with its edge, vector and pipeline state).
--
-- Cost: deleting a node is what scales. Every `ci.entities` delete runs the
-- `ON DELETE SET NULL` checks of `ci.position`'s compressed chunks, measured
-- on the copy at about 0.3 s a node (200 nodes in 61 s), the same as any
-- purge. Twins exist only where #2912's code re-imported Messenger before
-- this ran, so it is one node on the corpus; a dev database that re-imported
-- 2,471 attachments would spend about 12 minutes here.
--
-- Idempotent: once it has run, no `facebook` row hangs off a Messenger message,
-- so a second run finds no twins and re-keys nothing.

DROP TABLE IF EXISTS _messenger_attachments;
DROP TABLE IF EXISTS _messenger_attachment_losers;
DROP TABLE IF EXISTS _messenger_attachment_rekeyed;

-- ------------------------------------------------------- 1. working set --

CREATE TEMP TABLE _messenger_attachments ON COMMIT DROP AS
SELECT c.id,
       c.user_id,
       c.source_system,
       c.source_id,
       m.id AS message_id,
       -- Shape-agnostic: `attachments` is free-form jsonb at the API boundary.
       -- `attachmentsFor` writes `[{type:'file',id},{type:'content',id}]`.
       strpos(COALESCE(m.attachments::text, ''), c.id::text) > 0 AS named
  FROM ci.content c
  JOIN ci.communications m
    ON m.user_id = c.user_id
   AND m.source_system = 'facebook_messenger'
   AND m.source_id = COALESCE(
         substring(c.source_id FROM '^attachment:(.+):[0-9a-f]{64}$'),
         substring(c.source_id FROM '^(.+):attachment:[0-9]+$'))
 WHERE c.source_system IN ('facebook', 'facebook_messenger')
   AND c.source_id LIKE '%attachment:%';

CREATE INDEX ON _messenger_attachments (user_id, source_id);

-- -------------------------------------------------------------- 2. twins --

CREATE TEMP TABLE _messenger_attachment_losers ON COMMIT DROP AS
SELECT CASE WHEN pair.keep_messenger THEN pair.legacy_id ELSE pair.messenger_id END AS id,
       CASE WHEN pair.keep_messenger THEN pair.legacy_named ELSE pair.messenger_named END AS named,
       pair.user_id,
       pair.message_id
  FROM (
    SELECT legacy.id                             AS legacy_id,
           legacy.named                          AS legacy_named,
           messenger.id                          AS messenger_id,
           messenger.named                       AS messenger_named,
           legacy.user_id,
           legacy.message_id,
           messenger.named AND NOT legacy.named  AS keep_messenger
      FROM _messenger_attachments legacy
      JOIN _messenger_attachments messenger
        ON messenger.user_id = legacy.user_id
       AND messenger.source_id = legacy.source_id
       AND messenger.source_system = 'facebook_messenger'
     WHERE legacy.source_system = 'facebook'
  ) pair;

-- The message names both rows of a pair: drop the loser's entry, keep the
-- survivor's. The order of what stays is kept (`attachmentsFor` lists files,
-- then content).
UPDATE ci.communications m
   SET attachments = (
         SELECT COALESCE(jsonb_agg(a.entry ORDER BY a.ord), '[]'::jsonb)
           FROM jsonb_array_elements(m.attachments) WITH ORDINALITY AS a(entry, ord)
          WHERE NOT EXISTS (
            SELECT 1
              FROM _messenger_attachment_losers x
             WHERE x.message_id = m.id
               AND a.entry ->> 'id' = x.id::text))
 WHERE m.id IN (SELECT x.message_id FROM _messenger_attachment_losers x WHERE x.named)
   AND jsonb_typeof(m.attachments) = 'array';

-- ----------------------------------------------- 3. loser teardown --

-- clearHbpeLinks: HBPE's links, each taken off its cluster's member_count.
WITH gone AS (
  DELETE FROM hbpe.l2_content_cluster l
   WHERE l.content_id IN (SELECT id FROM _messenger_attachment_losers)
  RETURNING l.cluster_id
), per_cluster AS (
  SELECT cluster_id, count(*)::int AS members FROM gone GROUP BY cluster_id
)
UPDATE hbpe.l2_clusters c
   SET member_count = GREATEST(c.member_count - p.members, 0),
       updated_at = now()
  FROM per_cluster p
 WHERE c.cluster_id = p.cluster_id;

DELETE FROM hbpe.content_context cc
 WHERE cc.content_id IN (SELECT id FROM _messenger_attachment_losers);

-- deleteBareReferences(CONTENT_REFERENCES): edges both ways, with the deltas
-- that recorded them; then everything that names the id with no foreign key.
WITH gone AS (
  DELETE FROM ci.relationships r
   WHERE r.from_entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers))
      OR r.to_entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers))
  RETURNING r.relationship_id
)
DELETE FROM ci.graph_deltas gd
 WHERE gd.relationship_id IN (SELECT relationship_id FROM gone);

DELETE FROM ci.record_sources rs
 USING _messenger_attachment_losers x
 WHERE rs.user_id = x.user_id
   AND rs.record_table = 'content'
   AND rs.record_id = x.id;

DELETE FROM ci.pipeline_state ps
 WHERE ps.entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers));

DELETE FROM ci.pipeline_dead_letters dl
 WHERE dl.entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers));

DELETE FROM ci.graph_deltas gd
 WHERE gd.entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers));

DELETE FROM ci_search.entity_tag t
 WHERE t.entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers));

DELETE FROM ci_search.entity_categories ec
 WHERE ec.entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers));

DELETE FROM ci_search.vectors v
 WHERE v.entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers));

DELETE FROM ci_search.embeddings e
 WHERE e.entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers));

DELETE FROM ci_search.index_skips s
 WHERE s.entity_id = ANY (ARRAY(SELECT id FROM _messenger_attachment_losers));

-- Last: the base row. Its ON DELETE CASCADE takes the `ci.content` row (and
-- any entity_type_proposals) with it. The temp table is a materialized
-- snapshot, so it still lists the ids after the cascade.
DELETE FROM ci.entities en
 WHERE en.entity_type = 'Content'
   AND en.entity_id IN (SELECT id FROM _messenger_attachment_losers);

-- --------------------------------------------------------- 4. re-key --

CREATE TEMP TABLE _messenger_attachment_rekeyed ON COMMIT DROP AS
SELECT r.id, r.user_id, r.source_id
  FROM _messenger_attachments r
 WHERE r.source_system = 'facebook'
   AND NOT EXISTS (SELECT 1 FROM _messenger_attachment_losers x WHERE x.id = r.id);

UPDATE ci.content c
   SET source_system = 'facebook_messenger'
  FROM _messenger_attachment_rekeyed k
 WHERE c.id = k.id;

-- The ledger follows the row. Its unique key leaves out `record_id`, so a row
-- already holding the NEW key would make the re-key below collide, and a
-- migration that raises stops the appliance from starting. Two ways one can:
--
--  a. It names a record that is gone: a twin removed through the app's delete
--     (`ContentService.remove` leaves ledger rows behind, and
--     contentFacetsSql.ts's LIVE_LEDGER_RECORD_SQL already steps past them).
--     It evidences nothing; it goes.
DELETE FROM ci.record_sources stale
 USING _messenger_attachment_rekeyed k
 WHERE stale.user_id = k.user_id
   AND stale.record_table = 'content'
   AND stale.source_system = 'facebook_messenger'
   AND stale.source_id = k.source_id
   AND NOT EXISTS (SELECT 1 FROM ci.content c WHERE c.id = stale.record_id);

--  b. Anything else still holding it. The row's old-key arrival is then
--     redundant, and is dropped rather than re-keyed onto a taken key.
DELETE FROM ci.record_sources rs
 USING _messenger_attachment_rekeyed k
 WHERE rs.user_id = k.user_id
   AND rs.record_table = 'content'
   AND rs.record_id = k.id
   AND rs.source_system = 'facebook'
   AND rs.source_id = k.source_id
   AND EXISTS (
     SELECT 1
       FROM ci.record_sources held
      WHERE held.user_id = rs.user_id
        AND held.record_table = 'content'
        AND held.source_type = rs.source_type
        AND held.source_system = 'facebook_messenger'
        AND held.source_id = rs.source_id
        AND held.platform IS NOT DISTINCT FROM
              (CASE WHEN rs.platform = 'facebook' THEN 'facebook_messenger' ELSE rs.platform END));

UPDATE ci.record_sources rs
   SET source_system = 'facebook_messenger',
       platform = CASE WHEN rs.platform = 'facebook' THEN 'facebook_messenger' ELSE rs.platform END
  FROM _messenger_attachment_rekeyed k
 WHERE rs.user_id = k.user_id
   AND rs.record_table = 'content'
   AND rs.record_id = k.id
   AND rs.source_system = 'facebook'
   AND rs.source_id = k.source_id;

-- ## Post-migration verification
--
-- Should be 0: a Messenger attachment still under `facebook`.
--   SELECT count(*)
--     FROM ci.content c
--     JOIN ci.communications m
--       ON m.user_id = c.user_id AND m.source_system = 'facebook_messenger'
--      AND m.source_id = COALESCE(
--            substring(c.source_id FROM '^attachment:(.+):[0-9a-f]{64}$'),
--            substring(c.source_id FROM '^(.+):attachment:[0-9]+$'))
--    WHERE c.source_system = 'facebook';
--
-- Should be 0: a ledger row of a Messenger attachment still under `facebook`.
--   SELECT count(*)
--     FROM ci.record_sources rs
--     JOIN ci.content c ON c.id = rs.record_id
--    WHERE rs.record_table = 'content'
--      AND c.source_system = 'facebook_messenger'
--      AND (rs.source_system = 'facebook' OR rs.platform = 'facebook');
--
-- Should be 0: a message naming a content id that no longer exists.
--   SELECT count(*)
--     FROM ci.communications m, jsonb_array_elements(m.attachments) a(entry)
--    WHERE m.source_system = 'facebook_messenger'
--      AND jsonb_typeof(m.attachments) = 'array'
--      AND a.entry ->> 'type' = 'content'
--      AND NOT EXISTS (SELECT 1 FROM ci.content c WHERE c.id::text = a.entry ->> 'id');

-- migrate:down
-- No-op: irreversible, as the other identity repairs here are
-- (20260904035958_rekey_reddit_connection_records_onto_shared_identity).
-- A deleted twin cannot be rebuilt, and putting the survivors back under
-- `facebook` would only re-open the defect: #2912's code keys them under
-- `facebook_messenger`, so the next import would insert a twin beside each.
