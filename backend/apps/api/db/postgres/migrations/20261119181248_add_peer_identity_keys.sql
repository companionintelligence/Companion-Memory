-- migrate:up
-- ---------------------------------------------------------------------------
-- Each person on this box gets their own peer signing key.
--
-- A peer ask was signed with ONE box key (`peers.signingKeyJwk`, set by hand in
-- a config file), and because that key spoke for the whole box only its
-- administrator could send with it. This table gives every user an Ed25519 key
-- of their own, made the first time they need one. Its `did:key` is that
-- person's identity to other boxes: the other side links exactly that
-- identifier (`ci.peer_links.peer_issuer = 'did:key'`), so a signed ask says
-- which person asked, not merely which box.
--
-- `private_jwk` is written through `encryptedColumnTransformer` (AES-256-GCM
-- under AUTH_FIELD_ENCRYPTION_KEY), never in the clear.
--
-- A key is rotated by retiring it and making a new one. Retired keys are kept,
-- so a rotation notice that did not reach a peer can still be re-sent signed by
-- the key that peer knows.
-- ---------------------------------------------------------------------------

CREATE TABLE ci.peer_identity_keys (
    id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    -- did:key:z6Mk... of the public half. Globally unique: two users can never
    -- hold one key, so a did:key names exactly one person on this box.
    did_key TEXT NOT NULL,
    -- {crv, kty, x} only. The private half is never here.
    public_jwk JSONB NOT NULL,
    -- The private JWK as JSON, encrypted (enc:v1:...).
    private_jwk TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retired_at TIMESTAMPTZ,
    CONSTRAINT peer_identity_keys_did_key_shape_chk CHECK (did_key ~ '^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$'),
    CONSTRAINT peer_identity_keys_retired_chk CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX peer_identity_keys_did_key_uniq ON ci.peer_identity_keys (did_key);

-- One live key per person. Also what makes "make one the first time it is
-- needed" safe under a race: the loser's insert fails here and it reads the
-- winner's row.
CREATE UNIQUE INDEX peer_identity_keys_user_active_uniq
    ON ci.peer_identity_keys (user_id) WHERE status = 'active';

-- migrate:down
DROP TABLE IF EXISTS ci.peer_identity_keys;
