-- migrate:up
-- The asker-minted correlation id (`PeerAskBody.askId`) that identifies one
-- federated ask, bound to the local ci.asks row it produced.
--
-- WHY IT HAS TO BE PERSISTED. `askId` was documented as an idempotency key and
-- read by nothing: a repeat POST minted a SECOND ci.asks row and re-evaluated
-- it from scratch, so an ask the owner had personally approved landed back in
-- review and the approved answer never left the responder's box. Recording the
-- correlation is what lets a repeat replay the recorded outcome, and what lets
-- GET /agent/v1/ask/:askId collect an answer without creating anything.
--
-- SCOPED BY PEER LINK, NOT GLOBAL. Two peers may independently mint the same
-- uuid, and one must never be able to collect the other's answer, so the
-- uniqueness that matters is (peer_link_id, correlation_id). A bare unique
-- index on correlation_id would additionally let any peer probe whether a given
-- id is in use on this box.
--
-- request_digest binds one key to one question: a repeat carrying different
-- bytes is refused as malformed rather than handed the first question's answer.
--
-- CI-Server #1711 -> epic #1712, Phase 3 (federation).
CREATE TABLE ci.peer_ask_correlations (
    id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    -- The relationship this correlation belongs to. CASCADE matches ask_grants:
    -- a removed peer link takes its in-flight correlations with it, and the
    -- ci.asks rows and ci.ask_audit history they point at survive independently.
    peer_link_id UUID NOT NULL REFERENCES ci.peer_links(id) ON DELETE CASCADE,
    correlation_id TEXT NOT NULL,
    ask_id UUID NOT NULL REFERENCES ci.asks(id) ON DELETE CASCADE,
    request_digest TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The idempotency key itself. UNIQUE is load-bearing, not an optimization: two
-- concurrent POSTs carrying the same askId race to create an ask, and this is
-- what makes exactly one of them win at the database rather than both.
CREATE UNIQUE INDEX peer_ask_correlations_link_corr_uniq
    ON ci.peer_ask_correlations (peer_link_id, correlation_id);

-- One correlation per ask, in both directions: an inbound ask is created BY a
-- correlation, and an outbound ask mints exactly one.
CREATE UNIQUE INDEX peer_ask_correlations_ask_uniq ON ci.peer_ask_correlations (ask_id);

-- migrate:down
DROP TABLE IF EXISTS ci.peer_ask_correlations;
