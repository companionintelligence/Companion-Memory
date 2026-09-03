-- One-off cleanup: WhatsApp "LITA / Companion Tech Team" chat was pushed
-- under THREE different conversation-name spellings during 2026-08-18
-- testing of the re-import dedup fix (see commit 116cf46e9, "fix(import):
-- stop a WhatsApp re-import duplicating the entire chat"):
--
--   1. "LITA _ Companion Tech Team"                  (pre-fix inbox route)
--   2. "WhatsApp_Chat_-_LITA___Companion_Tech_Team"   (pre-fix upload route)
--   3. "LITA Companion Tech Team"                     (post-fix, normalized)
--
-- ci.communications.source_id / ci.events.source_id embed the conversation
-- name, so each spelling produced a genuinely distinct provenance triple and
-- the (user_id, source_type, source_system, source_id) unique index could not
-- catch the cross-spelling duplication -- that's the bug 116cf46e9 fixes going
-- forward. It does NOT retroactively merge rows already written under the old
-- spellings (documented in that commit's message). This script does the
-- retroactive merge for the one chat affected on this appliance.
--
-- Real-message identity, independent of the conversation-name bug:
--   communications: the "<timestamp>:<seq>" suffix of source_id
--     (whatsapp:<conversationName>:<timestamp>:<seq>)
--   events (media): the filename suffix of source_id
--     (whatsapp:media:<conversationName>:<filename>)
--
-- Verified before writing this script: every one of the 5,160 real messages
-- and 169 real attachments had EXACTLY 3 rows (no partial/stray duplicates),
-- for exactly 10,320 + 338 = 10,658 extra rows. The survivor kept per group is
-- the one already using the post-fix normalized spelling ("LITA Companion
-- Tech Team"), because that is the ONLY spelling future re-imports of this
-- export will produce -- keeping it is what makes the existing
-- communications_source_triple_uniq / events_source_triple_uniq indexes
-- actually dedupe on the next re-import. All 3 spellings had 100%
-- from_entity_id fill, so there's no data-quality reason to prefer another
-- survivor.
--
-- Blast radius checked before running (see session notes): ci.relationships,
-- ci.entity_identifiers, ci.item_relationships, ci_search.entity_tag,
-- ci.identifier_claims, ci.content all had ZERO rows referencing the affected
-- entity ids. ci_search.vectors / ci_search.embeddings DID (soft references,
-- no FK), so they're cleaned explicitly here before the source rows go --
-- entity_id in those tables is a plain column, not FK-enforced, so it survives
-- a cascade delete as a dangling pointer unless removed first (this is the same
-- category of cleanup backend/apps/api/scripts/search-index-cleanup.ts's
-- `orphans` command targets, run here inline against a known id set instead of
-- a full-table sweep).
--
-- ci.entities -> ci.communications / ci.events IS ON DELETE CASCADE, so
-- deleting the ci.entities row is sufficient to remove both the base entity
-- row and its detail row in one statement.
--
-- Idempotent: a second run finds nothing to delete (COUNT 0 at every step).
-- Read-only up to the final COMMIT; run inside a transaction and inspect the
-- NOTICEs before trusting it against another dataset.

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE whatsapp_comm_dupes AS
WITH dupe_groups AS (
  SELECT id, source_id,
    (regexp_match(source_id, ':([0-9T:.\-]+Z):(\d+)$'))::text AS msg_key,
    row_number() OVER (
      PARTITION BY (regexp_match(source_id, ':([0-9T:.\-]+Z):(\d+)$'))::text
      ORDER BY (source_id LIKE 'whatsapp:LITA Companion Tech Team:%') DESC, id
    ) AS rn
  FROM ci.communications
  WHERE source_system = 'whatsapp'
)
SELECT id FROM dupe_groups WHERE rn > 1;

CREATE TEMP TABLE whatsapp_event_dupes AS
WITH dupe_groups AS (
  SELECT event_id, source_id,
    regexp_replace(source_id, '^.*:', '') AS fname,
    row_number() OVER (
      PARTITION BY regexp_replace(source_id, '^.*:', '')
      ORDER BY (source_id LIKE 'whatsapp:media:LITA Companion Tech Team:%') DESC, event_id
    ) AS rn
  FROM ci.events
  WHERE source_system = 'whatsapp'
)
SELECT event_id FROM dupe_groups WHERE rn > 1;

DO $$
DECLARE
  n_comm int;
  n_event int;
BEGIN
  SELECT count(*) INTO n_comm FROM whatsapp_comm_dupes;
  SELECT count(*) INTO n_event FROM whatsapp_event_dupes;
  RAISE NOTICE 'about to remove % duplicate communications rows and % duplicate events rows', n_comm, n_event;
END $$;

-- Search index rows are a soft reference (entity_id column, no FK) and would
-- otherwise dangle after the entities cascade below.
DELETE FROM ci_search.vectors v
 WHERE (v.entity_type = 'communication' AND v.entity_id IN (SELECT id FROM whatsapp_comm_dupes))
    OR (v.entity_type = 'event' AND v.entity_id IN (SELECT event_id FROM whatsapp_event_dupes));

DELETE FROM ci_search.embeddings e
 WHERE (e.entity_type = 'communication' AND e.entity_id IN (SELECT id FROM whatsapp_comm_dupes))
    OR (e.entity_type = 'event' AND e.entity_id IN (SELECT event_id FROM whatsapp_event_dupes));

DELETE FROM ci_search.index_skips s
 WHERE (s.entity_type = 'communication' AND s.entity_id IN (SELECT id FROM whatsapp_comm_dupes))
    OR (s.entity_type = 'event' AND s.entity_id IN (SELECT event_id FROM whatsapp_event_dupes));

-- Deleting the ci.entities row cascades to ci.communications / ci.events
-- (communications_id_entities_fk / events_event_id_entities_fk are both
-- ON DELETE CASCADE).
DELETE FROM ci.entities
 WHERE (entity_type = 'Communication' AND entity_id IN (SELECT id FROM whatsapp_comm_dupes))
    OR (entity_type = 'Event' AND entity_id IN (SELECT event_id FROM whatsapp_event_dupes));

DO $$
DECLARE
  remaining_comm int;
  remaining_event int;
BEGIN
  SELECT count(*) INTO remaining_comm FROM ci.communications WHERE source_system = 'whatsapp';
  SELECT count(*) INTO remaining_event FROM ci.events WHERE source_system = 'whatsapp';
  RAISE NOTICE 'post-cleanup: % whatsapp communications remain, % whatsapp events remain', remaining_comm, remaining_event;

  IF remaining_comm <> 5160 THEN
    RAISE EXCEPTION 'expected exactly 5160 whatsapp communications to remain, got %; rolling back', remaining_comm;
  END IF;

  IF remaining_event <> 169 THEN
    RAISE EXCEPTION 'expected exactly 169 whatsapp events to remain, got %; rolling back', remaining_event;
  END IF;
END $$;

COMMIT;
