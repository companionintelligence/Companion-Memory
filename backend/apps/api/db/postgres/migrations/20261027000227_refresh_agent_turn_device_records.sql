-- migrate:up
-- Send phones the corrected direction of agent-turn messages.
--
-- 20261026044030_flip_agent_turn_direction set ci.communications.direction
-- the right way round on every `POST /memory/turn` row. Phones never read
-- ci.communications. They read a message's direction from its device record,
-- ci_search.mobile_search_documents.detail (entityDeviceRecord.ts), which is
-- written when the row is indexed and was not touched by that UPDATE. So an
-- agent turn indexed before the upgrade still shows on the phone with the old
-- direction: the owner's words as received, and the offline Sent / Received
-- filter returns the wrong side.
--
-- Dropping detail_version to 0 hands those records to
-- MobileSearchDocumentDetailCron, which re-derives detail from the row and
-- bumps updated_at, so PowerSync sends the new record to the device. Only
-- records whose stored direction differs from the row are reset, so a second
-- run finds nothing and records the fixed route wrote are left alone.
UPDATE ci_search.mobile_search_documents d
   SET detail_version = 0
  FROM ci.communications c
 WHERE c.category = 'agent-turn'
   AND d.entity_type = 'communication'
   AND d.entity_id = c.id
   AND d.detail ->> 'direction' IS DISTINCT FROM c.direction::text;

-- migrate:down
-- No-op. The cron re-derives each reset record from the row as it is now, so
-- there is nothing to put back.
SELECT 1;
