-- migrate:up
-- A peer Companion this box can exchange asks with — the local half of the
-- trust graph. Each box holds its OWN peer links; there is no central registry
-- of the graph itself (CI-Portal only provides *discovery*: handle → endpoint +
-- issuer, never the relationships).
--
-- Two bindings make a link useful:
--   1. (peer_issuer, peer_subject) — the OIDC identity that will present itself
--      on an inbound ask, matched against ci.federated_identities. This is how
--      an inbound request is attributed to a known peer rather than a stranger.
--   2. person_entity_id — the person in MY memory graph this peer *is*. That is
--      what lets "do you know X?" resolve, and lets ask_grants be expressed
--      against a real relationship instead of an opaque user id.
--
-- CI-Server #1711 → epic #1712, Phase 3 (federation).
CREATE TABLE ci.peer_links (
    id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    -- The local user who owns this peer relationship.
    owner_user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    -- Portal directory handle, e.g. 'maya' (resolved via CI-Portal discovery).
    peer_handle TEXT NOT NULL,
    display_name TEXT,
    -- Where this peer's Companion accepts asks (their /agent/v1 base URL).
    memory_endpoint TEXT NOT NULL,
    -- The peer's OIDC identity, used to authenticate THEIR inbound asks to us.
    peer_issuer TEXT,
    peer_subject TEXT,
    -- The person in the owner's memory graph that this peer corresponds to.
    -- Nullable: a link can exist before entity resolution matches a person.
    person_entity_id UUID,
    -- Relationship tier; feeds the grant/disclosure policy (see ask_grants).
    trust_tier TEXT NOT NULL DEFAULT 'peer'
        CHECK (trust_tier IN ('family', 'trusted', 'peer', 'stranger')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('pending', 'active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

-- One link per (owner, handle).
CREATE UNIQUE INDEX peer_links_owner_handle_uniq ON ci.peer_links (owner_user_id, peer_handle);

-- Inbound-ask lookup: "which of my peers is this (iss,sub)?"
CREATE INDEX peer_links_issuer_subject_idx
    ON ci.peer_links (peer_issuer, peer_subject) WHERE peer_issuer IS NOT NULL;

CREATE INDEX peer_links_person_idx ON ci.peer_links (person_entity_id) WHERE person_entity_id IS NOT NULL;

-- Records which peer an ask came from / went to, so a federated ask is
-- distinguishable from a local one and can be attributed in the audit trail.
ALTER TABLE ci.asks ADD COLUMN peer_link_id UUID REFERENCES ci.peer_links(id) ON DELETE SET NULL;
ALTER TABLE ci.asks ADD COLUMN direction TEXT NOT NULL DEFAULT 'local'
    CHECK (direction IN ('local', 'outbound', 'inbound'));

CREATE INDEX asks_peer_link_idx ON ci.asks (peer_link_id) WHERE peer_link_id IS NOT NULL;

-- An INBOUND ask has no local asker — the asker is a peer, identified by
-- peer_link_id. Minting a local shadow user for every peer would let anyone
-- reachable on the Portal accumulate an account on every box they can talk to,
-- so asker_user_id becomes nullable and the pair is constrained instead:
-- exactly one of (asker_user_id, peer_link_id) identifies who is asking.
ALTER TABLE ci.asks ALTER COLUMN asker_user_id DROP NOT NULL;
ALTER TABLE ci.asks ADD CONSTRAINT asks_asker_identified_chk CHECK (
    (direction = 'inbound' AND peer_link_id IS NOT NULL)
    OR (direction <> 'inbound' AND asker_user_id IS NOT NULL)
);

-- Grants must be expressible against a PEER as well as a local user, otherwise
-- a peer's ask could never match a standing pre-authorization. Exactly one of
-- (grantee_user_id, grantee_peer_link_id) is set.
ALTER TABLE ci.ask_grants ALTER COLUMN grantee_user_id DROP NOT NULL;
ALTER TABLE ci.ask_grants ADD COLUMN grantee_peer_link_id UUID
    REFERENCES ci.peer_links(id) ON DELETE CASCADE;
ALTER TABLE ci.ask_grants ADD CONSTRAINT ask_grants_grantee_chk CHECK (
    (grantee_user_id IS NOT NULL AND grantee_peer_link_id IS NULL)
    OR (grantee_user_id IS NULL AND grantee_peer_link_id IS NOT NULL)
);

CREATE INDEX ask_grants_peer_idx
    ON ci.ask_grants (grantee_peer_link_id) WHERE grantee_peer_link_id IS NOT NULL;

-- The audit trail must record a peer asker too. peer_link_id is deliberately
-- FK-LESS, matching this table's durability contract: an audit row outlives the
-- ask, the grant, and the peer link it describes (a revoked/removed peer must
-- not erase the history of what was disclosed to them).
ALTER TABLE ci.ask_audit ALTER COLUMN asker_user_id DROP NOT NULL;
ALTER TABLE ci.ask_audit ADD COLUMN peer_link_id UUID;
ALTER TABLE ci.ask_audit ADD COLUMN peer_handle TEXT;

-- migrate:down
ALTER TABLE ci.ask_audit DROP COLUMN IF EXISTS peer_handle;
ALTER TABLE ci.ask_audit DROP COLUMN IF EXISTS peer_link_id;
DROP INDEX IF EXISTS ci.ask_grants_peer_idx;
ALTER TABLE ci.ask_grants DROP CONSTRAINT IF EXISTS ask_grants_grantee_chk;
ALTER TABLE ci.ask_grants DROP COLUMN IF EXISTS grantee_peer_link_id;
ALTER TABLE ci.asks DROP CONSTRAINT IF EXISTS asks_asker_identified_chk;
DROP INDEX IF EXISTS ci.asks_peer_link_idx;
ALTER TABLE ci.asks DROP COLUMN IF EXISTS direction;
ALTER TABLE ci.asks DROP COLUMN IF EXISTS peer_link_id;
DROP TABLE IF EXISTS ci.peer_links;
