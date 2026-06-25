-- migrate:up
-- Identifier index for linking communications (and other capture rows) to the
-- graph Person they belong to. The graph stores People in ci.entities but their
-- contact identifiers (emails, phones) live only in `properties` JSON and are
-- not directly queryable. This table is the normalized identifier -> entity_id
-- lookup that the people-linking backfill resolves against.
--
-- Populated on graph ingest from a Person entity's properties.emails /
-- properties.phones (see GraphIngestService). `value_normalized` is stored using
-- the SAME normalization rule the importer applies (email = trim + lowercase;
-- phone = last 10 digits of the digit string), so a raw communication
-- participant can be normalized the same way and matched exactly.
--
-- kind is constrained to the identifier classes we resolve today: 'email',
-- 'phone'. The (owner_user_id, kind, value_normalized) UNIQUE index is the
-- upsert key (ON CONFLICT DO NOTHING) — an identifier is unique per user, but
-- the same value may legitimately map to a re-resolved entity_id over time, so
-- conflicts are ignored rather than overwriting. entity_id is indexed for the
-- reverse lookup (all identifiers of an entity).
CREATE TABLE IF NOT EXISTS ci.entity_identifiers (
    entity_id       UUID NOT NULL,
    owner_user_id   UUID NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
    value_normalized TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_identifiers_owner_kind_value_uniq
    ON ci.entity_identifiers (owner_user_id, kind, value_normalized);

CREATE INDEX IF NOT EXISTS entity_identifiers_entity_idx
    ON ci.entity_identifiers (entity_id);

-- migrate:down
DROP INDEX IF EXISTS ci.entity_identifiers_entity_idx;
DROP INDEX IF EXISTS ci.entity_identifiers_owner_kind_value_uniq;
DROP TABLE IF EXISTS ci.entity_identifiers;
