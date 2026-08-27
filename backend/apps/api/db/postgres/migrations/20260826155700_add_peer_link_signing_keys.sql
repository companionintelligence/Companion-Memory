-- migrate:up
-- ---------------------------------------------------------------------------
-- A peer link may now name a KEY, not only an OIDC identity.
--
-- `/agent/v1/ask` authenticates a peer with a CI-Portal OIDC bearer token, and
-- `ci.peer_links` is keyed on the `(peer_issuer, peer_subject)` that token
-- asserts. Three things follow, and all three are properties of bearer tokens
-- rather than of the implementation:
--
--   * A LEAKED TOKEN IS A COMPLETE IMPERSONATION for its whole lifetime.
--     Nothing binds the token to the request it arrived on.
--   * NOTHING BINDS THE TOKEN TO THE BODY. Anything on the path can rewrite the
--     question between the peer and this box and the token still verifies.
--   * REPLAY IS UNDETECTABLE. Only the `askId` idempotency key limits the
--     damage, and it limits it per-key, not per-request.
--
-- UMA-for-agents makes retiring bearer RPTs its recommendation #4 for exactly
-- this. The answer here is RFC 9421 HTTP message signatures: the peer signs
-- each request with the key that IS its identity, over a base covering the
-- method, the target and a digest of the body, with a nonce and a bounded
-- validity window.
--
-- IDENTITY, AND WHY THE KEY OUTRANKS THE TOKEN. UMA's FLOW.md runs four
-- identity regimes and shows the owner's policy is identical under all of them,
-- because the verifying key -- not an identity document -- is what authenticates
-- a request. Our consent code already agrees: nothing in `grantMatch.ts` or
-- `policy.ts` mentions an issuer. The coupling to CI-Portal lives entirely in
-- the link layer, which is what this migration starts to loosen: a link may now
-- be found by key thumbprint, with `(peer_issuer, peer_subject)` demoted to an
-- ATTESTATION that describes a peer rather than the thing that identifies it.
--
-- Both columns are nullable and nothing is backfilled: every existing link keeps
-- authenticating exactly as it does today. `peers.requireHttpSignature` is off
-- by default, so this migration changes no behaviour on its own.
--
-- CI-Server #1711 -> epic #1712.
-- ---------------------------------------------------------------------------

-- The peer's Ed25519 PUBLIC key, as a JWK. Public only -- `publicKeyFromJwk`
-- refuses a JWK carrying `d` rather than stripping it, so a private key cannot
-- be stored here by accident and then used to "verify" its own signatures.
ALTER TABLE ci.peer_links
    ADD COLUMN IF NOT EXISTS peer_key_jwk JSONB;

-- RFC 7638 thumbprint of that key, base64url SHA-256 over the canonical
-- {crv,kty,x}. Denormalized from `peer_key_jwk` rather than computed per
-- request because it is the LOOKUP key: an inbound signature names it in
-- `keyid`, and resolving that to a link must be one index hit, not a scan that
-- hashes every peer's key.
ALTER TABLE ci.peer_links
    ADD COLUMN IF NOT EXISTS peer_key_thumbprint TEXT;

-- Pinned to the shape `jwkThumbprint` produces. A column that can hold a
-- 4-character string is a column that will, and a short thumbprint is a
-- thumbprint that collides.
ALTER TABLE ci.peer_links
    ADD CONSTRAINT peer_links_key_thumbprint_shape_chk
    CHECK (peer_key_thumbprint IS NULL OR peer_key_thumbprint ~ '^[A-Za-z0-9_-]{43}$');

-- Both or neither. A thumbprint with no key cannot verify anything, and a key
-- with no thumbprint cannot be found.
ALTER TABLE ci.peer_links
    ADD CONSTRAINT peer_links_key_paired_chk
    CHECK ((peer_key_jwk IS NULL) = (peer_key_thumbprint IS NULL));

-- ONE LIVE LINK PER (owner, key). Load-bearing, not an optimization: without it
-- an owner could hold two active links for the same key with different trust
-- tiers, and which one answered would be decided by heap order -- the same
-- defect `grantMatch.strictestOf` was written to end for grants.
--
-- Scoped to the OWNER rather than global, because two different people on this
-- box may each independently link the same peer, and one must not block the
-- other. Partial on `revoked_at IS NULL` so a revoked link and its replacement
-- coexist.
CREATE UNIQUE INDEX IF NOT EXISTS peer_links_owner_key_live_uniq
    ON ci.peer_links (owner_user_id, peer_key_thumbprint)
    WHERE peer_key_thumbprint IS NOT NULL AND revoked_at IS NULL;

-- The inbound lookup: thumbprint from a signature's `keyid` -> live link.
CREATE INDEX IF NOT EXISTS peer_links_key_thumbprint_idx
    ON ci.peer_links (peer_key_thumbprint)
    WHERE peer_key_thumbprint IS NOT NULL AND revoked_at IS NULL;

COMMENT ON COLUMN ci.peer_links.peer_key_thumbprint IS
    'RFC 7638 thumbprint of peer_key_jwk. The identity an RFC 9421 signature names in keyid.';

-- migrate:down
DROP INDEX IF EXISTS ci.peer_links_key_thumbprint_idx;
DROP INDEX IF EXISTS ci.peer_links_owner_key_live_uniq;
ALTER TABLE ci.peer_links DROP CONSTRAINT IF EXISTS peer_links_key_paired_chk;
ALTER TABLE ci.peer_links DROP CONSTRAINT IF EXISTS peer_links_key_thumbprint_shape_chk;
ALTER TABLE ci.peer_links DROP COLUMN IF EXISTS peer_key_thumbprint;
ALTER TABLE ci.peer_links DROP COLUMN IF EXISTS peer_key_jwk;
