-- migrate:up
-- Reissued from 20260628120000, which collided with
-- communications_source_dedup_table (both hand-stamped the same version;
-- dbmate keys schema_migrations on it). DBs that migrated while this file held
-- the old version will run it again — every statement below is guarded, so the
-- re-run is a no-op.
--
-- Sharing for saved searches (LifeScope "tag stream" sharing parity). A saved
-- search can be marked public; the unguessable share_token is a capability that
-- lets another signed-in user open the search and run it as the owner. Toggling
-- sharing off clears the token (revokes outstanding links); re-sharing mints a
-- fresh one.
ALTER TABLE ci.saved_searches
    ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS share_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS saved_searches_share_token_key
    ON ci.saved_searches (share_token)
    WHERE share_token IS NOT NULL;

-- Bind the two columns so they can never drift: a public search always carries a
-- token and a private one never does. The token-leak guard (findByShareToken
-- requires is_public = true) then rests on a DB invariant, not just on the one
-- application writer keeping them in sync.
ALTER TABLE ci.saved_searches
    DROP CONSTRAINT IF EXISTS saved_searches_share_token_consistency;
ALTER TABLE ci.saved_searches
    ADD CONSTRAINT saved_searches_share_token_consistency
    CHECK ((is_public AND share_token IS NOT NULL) OR (NOT is_public AND share_token IS NULL));

-- migrate:down
ALTER TABLE ci.saved_searches
    DROP CONSTRAINT IF EXISTS saved_searches_share_token_consistency;

DROP INDEX IF EXISTS ci.saved_searches_share_token_key;

ALTER TABLE ci.saved_searches
    DROP COLUMN IF EXISTS is_public,
    DROP COLUMN IF EXISTS share_token;
