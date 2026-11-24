-- migrate:up
-- ci.pending_actions.reason: accept 'write-after-lookup'.
--
-- A chat turn that has looked something up may act on what the lookup
-- returned, which can be a mail or a note someone else wrote. Under a
-- trust dial that asks before a delete (balanced, cautious), such a turn's
-- writes now wait for the owner too, not only its deletes and sends.
-- resolveToolGate queues them with this reason, so the Approvals card can say
-- why. The CHECK from 20260826202654_create_pending_actions.sql allowed only
-- the four older reasons, so the insert would fail.
--
-- The constraint keeps its name.
ALTER TABLE ci.pending_actions
    DROP CONSTRAINT IF EXISTS pending_actions_reason;

ALTER TABLE ci.pending_actions
    ADD CONSTRAINT pending_actions_reason CHECK (
        reason IN (
            'destructive-requires-confirmation',
            'external-leaves-appliance',
            'not-local-capable',
            'confirmation-required',
            'write-after-lookup'
        )
    );

-- migrate:down
-- ADD CONSTRAINT checks every row, so rows with the new reason are relabelled
-- first, as 'confirmation-required' (the reason the trust dial queues under).
-- Their intent and input are unchanged and an open card can still be approved.
-- It then shows that reason's wording on the Approvals page ("This is
-- irreversible, and an installed app asked for it."), which is wrong for these
-- rows: the write can be undone and the owner's chat asked for it.
UPDATE ci.pending_actions
   SET reason = 'confirmation-required'
 WHERE reason = 'write-after-lookup';

ALTER TABLE ci.pending_actions
    DROP CONSTRAINT IF EXISTS pending_actions_reason;

ALTER TABLE ci.pending_actions
    ADD CONSTRAINT pending_actions_reason CHECK (
        reason IN (
            'destructive-requires-confirmation',
            'external-leaves-appliance',
            'not-local-capable',
            'confirmation-required'
        )
    );
