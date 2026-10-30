-- migrate:up
-- ci.pending_actions.reason: accept 'read-after-lookup'.
--
-- A chat turn that has looked something up may then ask an outside service
-- something, and the query can come from what the lookup returned: a mail or a
-- page someone else wrote. Under the balanced and cautious dials such a read
-- now waits for the owner. resolveToolGate queues it with this reason so the
-- Approvals card can say why. The CHECK from
-- 20261029112131_pending_actions_write_after_lookup_reason.sql does not allow
-- it, so the insert would fail.
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
            'write-after-lookup',
            'read-after-lookup'
        )
    );

-- migrate:down
-- ADD CONSTRAINT checks every row, so rows with the new reason are relabelled
-- first, as 'external-leaves-appliance'. Nothing runs differently by reason:
-- an open card can still be approved. Its card then says "This sends data to a
-- third party, off your appliance.", which is true of these reads.
UPDATE ci.pending_actions
   SET reason = 'external-leaves-appliance'
 WHERE reason = 'read-after-lookup';

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
