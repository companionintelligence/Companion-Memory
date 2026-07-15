-- migrate:up
-- Short-lived, single-use authorization codes for the app-connect flow.
--
-- When a user consents (on ci-memory) to connect an app to their Companion
-- Memory, the server hands the browser a one-time `code`. CI-Hub then exchanges
-- that code server-to-server, and the key is minted at that moment (never at
-- consent time, so an abandoned flow can't destroy an app's existing key). The
-- code is a pure authorization grant: it carries NO key material at rest — only
-- the identity + app it authorizes minting for.
CREATE TABLE ci.connect_codes (
    id UUID PRIMARY KEY,

    -- SHA-256 of the raw code; the raw code is only ever in the redirect URL.
    hashed_code TEXT NOT NULL,

    -- Binds the code to the identity + app it authorizes, so the exchange
    -- (and any audit) can assert who/what it belongs to.
    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    app_urn TEXT NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_connect_codes_hashed_code ON ci.connect_codes(hashed_code);
-- Supports the sweep of expired/consumed codes.
CREATE INDEX idx_connect_codes_expires_at ON ci.connect_codes(expires_at);

-- migrate:down
DROP TABLE IF EXISTS ci.connect_codes;
