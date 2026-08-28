-- migrate:up
-- Resolved link previews ("unfurls") for content rows: what a URL, a provider
-- handle (spotify:track:…) or a streaming title (Netflix/Prime) turns into once
-- the appliance asks the provider — title, author, poster, duration, a Wikidata id.
--
-- Keyed by resolve_key, NOT by content id: 33k Spotify plays of 5k tracks are
-- 5k rows here, and every content row whose (url | external_id | title)
-- derives the same key shares the row. The key is a pure function of the
-- content row (domains/embed/resolveKey.ts), so nothing links back to content;
-- the GraphQL loader recomputes it at read time.
--
-- The stage that fills this is `enrich.unfurl` (ci.pipeline_state is its
-- ledger); this table is the CACHE the stage consults before any network call,
-- so a re-sweep or a version bump re-reads rather than re-fetches until
-- expires_at passes.
CREATE TABLE IF NOT EXISTS ci.unfurls (
    id               uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id          uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    resolve_key      text NOT NULL,
    -- oembed | wikidata | opengraph
    resolver         text NOT NULL,
    -- ok | not_found | not_embeddable | blocked | transport_error | rate_limited
    -- (vocabulary lives in domains/embed/services/UnfurlService.ts, not a CHECK,
    -- so a new outcome is a code change and not a migration)
    status           text NOT NULL,
    title            text,
    author_name      text,
    author_url       text,
    site_name        text,
    description      text,
    -- The provider's own page for the thing (Wikipedia article, canonical watch URL).
    canonical_url    text,
    -- Remote poster/thumbnail as the provider served it.
    thumbnail_url    text,
    -- Local copy of the poster in object storage (FileVariant THUMBNAIL); the
    -- UI prefers this so a dead provider link does not blank the tile.
    poster_file_id   uuid REFERENCES ci.files(id) ON DELETE SET NULL,
    duration_seconds integer,
    -- Stable reference into the provider's catalogue, e.g. wikidata:Q28443710.
    external_ref     text,
    -- The subset of the provider response worth keeping (year, genres, …).
    payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
    failure_count    integer NOT NULL DEFAULT 0,
    fetched_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, resolve_key)
);

CREATE INDEX IF NOT EXISTS unfurls_user_expires_idx
    ON ci.unfurls (user_id, expires_at)
    WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS unfurls_poster_file_idx
    ON ci.unfurls (poster_file_id)
    WHERE poster_file_id IS NOT NULL;

-- migrate:down
DROP TABLE IF EXISTS ci.unfurls;
