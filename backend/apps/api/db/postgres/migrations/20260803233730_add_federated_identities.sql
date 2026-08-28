-- migrate:up
-- Binds an external OIDC identity (issuer + subject) to a local CI-Server user.
--
-- WHY THIS EXISTS (security prerequisite for peer/federated asks): today
-- PortalTokenService JIT-provisions a user from the token's `email` claim alone.
-- Email is re-assignable and not globally unique across issuers, so once a
-- SECOND issuer (a peer box, a partner IdP) is trusted, an attacker who controls
-- an email at any trusted issuer inherits the local account — a cross-box
-- account-takeover primitive. The (iss, sub) pair is the only stable, globally
-- unique subject identifier OIDC guarantees, so it becomes the binding key and
-- email is demoted to a one-time linking hint for pre-existing accounts.
--
-- CI-Server #1711 → epic #1712, Phase 3 (federation).
CREATE TABLE ci.federated_identities (
    id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    -- OIDC issuer (`iss`) — the Portal, or a peer box's did:web-backed issuer.
    issuer TEXT NOT NULL,
    -- OIDC subject (`sub`) — stable and unique WITHIN the issuer.
    subject TEXT NOT NULL,
    -- Email as asserted by the issuer at bind time. Recorded for audit only;
    -- never used for matching after the initial link.
    email TEXT,
    -- How the binding was established: 'sub' = matched/created on (iss,sub);
    -- 'email_link' = one-time migration link to a pre-existing local account.
    bind_method TEXT NOT NULL DEFAULT 'sub' CHECK (bind_method IN ('sub', 'email_link')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The binding key: one local user per (issuer, subject).
CREATE UNIQUE INDEX federated_identities_iss_sub_uniq
    ON ci.federated_identities (issuer, subject);

CREATE INDEX federated_identities_user_idx ON ci.federated_identities (user_id);

-- migrate:down
DROP TABLE IF EXISTS ci.federated_identities;
