-- migrate:up
-- ---------------------------------------------------------------------------
-- One question, several people, each answering on their own terms.
--
-- `ci.asks` names exactly ONE responder, so every use case that is really "ask
-- the group" was inexpressible: F9 (pool everyone's photos from the reunion),
-- W7 (anyone from the '19 cohort now in climate?), and the whole shape of
-- asking a household rather than a housemate.
--
-- ═══ A BROADCAST IS N INDEPENDENT ASKS, NOT ONE ASK WITH N RESPONDERS ═══
--
-- This is the whole design, and the alternative is worse in a way that is easy
-- to miss. A single ask row with several responders would mean ONE consent
-- decision, ONE ceiling and ONE audit row covering several people's memories --
-- so the strictest person's posture would either be overridden by the group's,
-- or would silently cap everybody else's.
--
-- Instead the broadcast is a CORRELATION. Each responder gets their own
-- `ci.asks` row, evaluated against their own grants, capped by their own tier,
-- reviewed in their own inbox, redacted by their own hand and audited in their
-- own history. Nothing about the group changes what any one of them discloses.
-- The broadcast exists only so the ASKER can see them as one question.
--
-- ═══ A RESPONDER LEARNS NOTHING ABOUT THE OTHERS ═══
--
-- Who else was asked is a fact about the ASKER's relationships, and disclosing
-- it to a responder would be a third-party disclosure nobody consented to --
-- "Ana asked me, and I now know she also asked Dana and Sam" is exactly the
-- kind of leak this domain closes elsewhere (the decline oracle, the peer
-- handle, `consentBasis` being responder-only).
--
-- So `broadcast_id` is on the ask row for the ASKER's benefit and is projected
-- to nobody else: `AskType.toType` returns it only to the asker, the same way
-- `consentBasis` is returned only to the responder. The table carries no member
-- list at all -- the asks ARE the list, and they are already scoped per party.
--
-- CI-Server #1711 -> epic #1712. USE-CASES.md F9, W7.
-- ---------------------------------------------------------------------------

CREATE TABLE ci.ask_broadcasts (
    id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    asker_user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    -- The question as the asker wrote it once. Denormalized onto every child
    -- ask as well, because an ask must remain answerable and auditable on its
    -- own -- `ci.ask_audit` outlives both parties and cannot depend on a join.
    query JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- The asker's own list of questions they have put to a group.
CREATE INDEX ask_broadcasts_asker_idx ON ci.ask_broadcasts (asker_user_id, created_at DESC);

-- The correlation, on the ask.
--
-- ON DELETE SET NULL rather than CASCADE: deleting the asker's grouping must
-- not delete the RESPONDERS' asks. Each of those is a consent decision that
-- belongs to the person who made it, and a broadcast is only the asker's view
-- of them. This is the same reasoning `ci.ask_audit.ask_id` uses for its own
-- soft reference.
ALTER TABLE ci.asks
    ADD COLUMN IF NOT EXISTS broadcast_id UUID REFERENCES ci.ask_broadcasts(id) ON DELETE SET NULL;

-- "Show me the answers to the question I asked the group."
CREATE INDEX IF NOT EXISTS asks_broadcast_idx
    ON ci.asks (broadcast_id)
    WHERE broadcast_id IS NOT NULL;

-- ONE ASK PER RESPONDER PER BROADCAST.
--
-- Load-bearing, not an optimization: without it a retry or a double-submit
-- puts the same question in one person's inbox twice, and each copy carries its
-- own independent consent decision. The owner would then be asked to consent to
-- the same thing twice, and a `deny` on one copy would sit beside an `auto` on
-- the other -- which of them "the answer" is would be decided by heap order.
--
-- Partial because a NULL broadcast is an ordinary one-to-one ask and there may
-- be any number of those between the same two people.
CREATE UNIQUE INDEX IF NOT EXISTS asks_broadcast_responder_uniq
    ON ci.asks (broadcast_id, responder_user_id)
    WHERE broadcast_id IS NOT NULL AND responder_user_id IS NOT NULL;

COMMENT ON COLUMN ci.asks.broadcast_id IS
    'Correlates asks the asker sent as one question. Projected to the ASKER only -- who else was asked is a fact about their relationships.';

-- migrate:down
DROP INDEX IF EXISTS ci.asks_broadcast_responder_uniq;
DROP INDEX IF EXISTS ci.asks_broadcast_idx;
ALTER TABLE ci.asks DROP COLUMN IF EXISTS broadcast_id;
DROP TABLE IF EXISTS ci.ask_broadcasts;
