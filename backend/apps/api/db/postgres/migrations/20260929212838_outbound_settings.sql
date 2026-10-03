-- migrate:up

-- ═══════════════════════════════════════════════════════════════════════════
-- The user's switches for the few things this appliance sends off the box.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Four outbound paths are documented (docs.ci.computer, "What leaves your
-- appliance"): crash reports, place lookups, link previews and Portal-brokered
-- OAuth sign-in. Until this table each was either on for everyone or off by an
-- operator editing the environment and restarting. This is the durable,
-- runtime answer: one row per path, read by every process a few seconds after
-- it changes, enforced where the request would actually leave.
--
-- ── Why a purpose-built table and not a generic settings table ─────────────
--
-- There is deliberately no `app_config` key/value table in this codebase (the
-- VAPID comment in configuration.ts says why: an open-ended bag of settings is
-- where secrets and half-remembered flags collect). This follows
-- `ci.job_settings` instead: a CLOSED key set enforced by a CHECK, so a typo'd
-- key is an INSERT error rather than a switch that silently never applies, and
-- widening the set is a reviewed migration.
--
-- ── The row vocabulary ─────────────────────────────────────────────────────
--
--   key='crash_reports'  Sentry error reporting (API process and the browser
--                        bundle, which asks GET /config/telemetry first).
--   key='place_lookups'  Geocoding / reverse geocoding through CI Portal.
--   key='link_previews'  Fetching a title, poster and description for a link.
--   key='portal_oauth'   Starting a NEW connected-service sign-in through the
--                        Portal OAuth proxy. Token refresh for a connection
--                        that already lives at Portal is deliberately NOT
--                        governed by this row.
--
-- ── Why NULL / absent is a value ───────────────────────────────────────────
--
-- Every path ships ON. `enabled` is nullable and NULL means "no opinion,
-- inherit the shipped default", exactly like `ci.job_settings.mode`; an
-- appliance whose owner has never opened the Privacy page holds ZERO rows here
-- and behaves as it did before this table existed. Nothing is seeded.
--
-- ── Scope ──────────────────────────────────────────────────────────────────
--
-- Appliance-wide: there is no user_id. The enforcement points (the Sentry
-- transport, the geocode provider call, the unfurl fetch, the OAuth proxy)
-- either have no user in scope or protect the whole box's egress, and the
-- appliance is one household's. `updated_by` is provenance, not ownership.
CREATE TABLE IF NOT EXISTS ci.outbound_settings (
    key         text        NOT NULL,

    -- NULL = inherit the shipped default (ON).
    enabled     boolean,

    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- Who last changed it. Nullable and ON DELETE SET NULL so deleting an
    -- account cannot take an appliance-wide setting with it.
    updated_by  uuid        REFERENCES ci.users (id) ON DELETE SET NULL,

    PRIMARY KEY (key),

    CONSTRAINT outbound_settings_key_check
        CHECK (key IN ('crash_reports', 'place_lookups', 'link_previews', 'portal_oauth'))
);

COMMENT ON TABLE ci.outbound_settings IS
  'Appliance-wide, persisted user switches for the documented outbound paths (crash reports, place lookups, link previews, Portal OAuth sign-in). Zero rows means every path is on, which is why nothing is seeded. Read by every process on a short poll and enforced at the point the request would leave.';

COMMENT ON COLUMN ci.outbound_settings.key IS
  'Closed set, matched by a CHECK: crash_reports | place_lookups | link_previews | portal_oauth. Widening it is a migration.';

COMMENT ON COLUMN ci.outbound_settings.enabled IS
  'NULL = no opinion, inherit the shipped default (ON). false = the user turned this path off. An operator kill switch in the environment (CI_TELEMETRY, CI_LOCAL_ONLY, UNFURL_ENABLED) still wins over a true here.';

-- migrate:down

DROP TABLE IF EXISTS ci.outbound_settings;
