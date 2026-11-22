-- migrate:up
-- ---------------------------------------------------------------------------
-- Invites: how two people link their Companions with one shared code.
--
-- The owner makes an invite and hands its code to the other person over any
-- channel they trust. The code carries this box's address, the owner's did:key
-- and a one-time secret. The other person's box checks the address really holds
-- that key, then presents the secret in a request signed by THEIR key; this box
-- checks the secret, checks their address holds their key, and both sides link
-- each other by key at the lowest trust tier.
--
-- Only a SHA-256 of the secret is stored, so a copy of this table cannot be
-- used to accept anyone's invite. An invite is single use, and expires.
-- ---------------------------------------------------------------------------

CREATE TABLE ci.peer_invites (
    id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    owner_user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    -- base64url SHA-256 of the secret in the code.
    secret_hash TEXT NOT NULL,
    -- The owner's did:key when the invite was made. The other side checks the
    -- box holds exactly this key, so a later rotation retires the invite.
    inviter_did_key TEXT NOT NULL,
    -- The name the other person sees for the owner. Chosen at creation.
    inviter_name TEXT NOT NULL,
    -- The owner's own note on who it is for. Shown only to the owner.
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    -- The link accepting it made on this box. SET NULL keeps the invite's
    -- history readable if that link row is ever deleted.
    used_link_id UUID REFERENCES ci.peer_links(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT peer_invites_secret_hash_shape_chk CHECK (secret_hash ~ '^[A-Za-z0-9_-]{43}$'),
    CONSTRAINT peer_invites_expiry_chk CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX peer_invites_secret_hash_uniq ON ci.peer_invites (secret_hash);

CREATE INDEX peer_invites_owner_idx ON ci.peer_invites (owner_user_id, created_at DESC);

-- migrate:down
DROP TABLE IF EXISTS ci.peer_invites;
