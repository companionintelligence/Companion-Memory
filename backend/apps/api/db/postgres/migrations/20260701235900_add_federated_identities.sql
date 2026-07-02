-- migrate:up
-- Binds a CI-Portal (OIDC IdP) identity to a local CI-Server user by the stable
-- pair (issuer, subject) rather than by email. Closes the email-trust gap from
-- the unified-identity-plan §1.1: today PortalTokenService JIT-provisions purely
-- on the email claim, so a re-used / re-assigned email at the IdP would silently
-- take over an existing appliance account. The (iss, sub) pair is the only
-- OIDC-stable, non-reassignable user handle, so we key the binding on it.
--
-- issuer  = OIDC `iss` claim (the Portal token issuer URL).
-- subject = OIDC `sub` claim (opaque, stable per-user at that issuer).
-- user_id = the local ci.users row this external identity resolves to.
--
-- UNIQUE (issuer, subject) is the lookup/upsert key: one external identity maps
-- to exactly one local user. A local user may have several federated identities
-- (multiple issuers / future account-linking, plan Track B6), so user_id is NOT
-- unique. The row is deleted with its user (ON DELETE CASCADE).
--
-- email match is retained by the service ONLY as a one-time migration fallback
-- for users provisioned before this table existed; once matched, the (iss, sub)
-- binding is written here and email is never trusted for identity again.
CREATE TABLE IF NOT EXISTS ci.federated_identities (
    id          uuid        PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    issuer      text        NOT NULL,
    subject     text        NOT NULL,
    user_id     uuid        NOT NULL REFERENCES ci.users (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS federated_identities_issuer_subject_uniq
    ON ci.federated_identities (issuer, subject);

CREATE INDEX IF NOT EXISTS federated_identities_user_idx
    ON ci.federated_identities (user_id);

-- migrate:down
DROP INDEX IF EXISTS ci.federated_identities_user_idx;
DROP INDEX IF EXISTS ci.federated_identities_issuer_subject_uniq;
DROP TABLE IF EXISTS ci.federated_identities;
