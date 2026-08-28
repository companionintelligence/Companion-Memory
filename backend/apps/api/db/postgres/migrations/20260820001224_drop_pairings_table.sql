-- migrate:up
-- The device-pairing backend (`PairingController`/`PairingService`/
-- `PairingResolver`, GraphQL `startPairing`/`pairingStatus`, REST
-- `POST /pairing/complete`, and the web-side `AppletPairPage`) is unused.
--
-- Traced the full surface before dropping it: `startPairing()`'s own resolver
-- hard-codes `pairingPath: /pair?token=...`, and `/pair` is not registered
-- anywhere in frontend/apps/web/src/App.tsx — so nothing in the web app has
-- ever been able to REACH the approval page, and nothing calls `startPairing`
-- to begin a pairing session in the first place. Confirmed CI-Capture (the
-- app this was originally built for, formerly CI-Applet) does not use it
-- either — it signs in through Portal OIDC (`launch_portal_login` in its
-- main.rs), not device pairing; a repo-wide grep for `startPairing`,
-- `pairingStatus`, `pairingToken`, `pairing/complete` and `appletAccessToken`
-- across CI-Capture returns nothing. The same grep across every other
-- sibling repo that could plausibly call this over the public GraphQL API —
-- CI-Pebble, CI-Mentra, CI-OMI, CI-Even-Realities,
-- CI-Home-Assistant-Voice-PE, CI-Hub, CI-Portal — also returns nothing.
--
-- `ci.pairings` holds 0 rows on the live appliance this was checked against,
-- so this drops an empty table, not data.
DROP TABLE ci.pairings;

-- migrate:down
CREATE TABLE ci.pairings (
    id UUID PRIMARY KEY,
    pairing_token TEXT UNIQUE NOT NULL,
    poll_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    user_id UUID REFERENCES ci.users(id),
    device_id TEXT,
    access_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
