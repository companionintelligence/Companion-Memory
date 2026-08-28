-- migrate:up
-- Complete the federated ask model for the OUTBOUND direction.
--
-- The inbound work made `asker_user_id` nullable (an inbound ask has no local
-- asker — the peer is identified by `peer_link_id`). Outbound is the mirror
-- image and was never expressed: when THIS box asks a peer, there is no local
-- responder, so `responder_user_id` has nothing meaningful to hold. Forcing a
-- value there would mean inventing a shadow user for the remote person, which is
-- exactly the accumulation the inbound design refused.
--
-- The two constraints together now say, per direction:
--   local    — both user ids set, no peer link
--   inbound  — peer asks, local user responds  (asker NULL,    responder NOT NULL)
--   outbound — local user asks, peer responds  (asker NOT NULL, responder NULL)
ALTER TABLE ci.asks ALTER COLUMN responder_user_id DROP NOT NULL;

ALTER TABLE ci.asks ADD CONSTRAINT asks_responder_identified_chk CHECK (
    (direction = 'outbound' AND peer_link_id IS NOT NULL AND responder_user_id IS NULL)
    OR (direction <> 'outbound' AND responder_user_id IS NOT NULL)
);

-- ci.ask_audit denormalizes both parties and is deliberately FK-less so it
-- outlives them; the same nullability applies for an outbound record.
ALTER TABLE ci.ask_audit ALTER COLUMN responder_user_id DROP NOT NULL;

-- migrate:down
ALTER TABLE ci.ask_audit ALTER COLUMN responder_user_id SET NOT NULL;
ALTER TABLE ci.asks DROP CONSTRAINT IF EXISTS asks_responder_identified_chk;
ALTER TABLE ci.asks ALTER COLUMN responder_user_id SET NOT NULL;
