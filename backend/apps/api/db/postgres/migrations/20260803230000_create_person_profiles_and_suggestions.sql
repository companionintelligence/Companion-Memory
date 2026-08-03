-- migrate:up
-- People-system rebuild (#1810), part 2: source profiles, sticky user
-- corrections, and duplicate suggestions. (Part 1 —
-- 20260803211455_add_person_identity_and_merge — owns the
-- merged_into_entity_id tombstone column, its index, and ci.entity_merges.)
--
-- ci.person_profiles is the per-source profile layer (the old LifeScope
-- "contacts" idea): one row per (source_system, remote_key) carrying the raw
-- identity fragments a source exported (display name, handle, avatar,
-- emails/phones). Profiles point at the canonical Person in ci.entities;
-- person_entity_id is NULL for a profile not yet assembled into a person.
-- No FK constraints, matching ci.entity_identifiers' loose coupling to
-- ci.entities.
CREATE TABLE IF NOT EXISTS ci.person_profiles (
    profile_id       UUID PRIMARY KEY,
    owner_user_id    UUID NOT NULL,
    -- Where the profile came from, e.g. 'google:contacts', 'discord',
    -- 'communications:participant', 'files:face', 'manual'.
    source_system    TEXT NOT NULL,
    -- Stable per-source key (importer natural key, remote id, or a
    -- kind:value composite for participant stubs). Idempotency anchor.
    remote_key       TEXT NOT NULL,
    display_name     TEXT,
    handle           TEXT,
    avatar_url       TEXT,
    -- Normalized identifier arrays (same rule as ci.entity_identifiers).
    emails           TEXT[] NOT NULL DEFAULT '{}',
    phones           TEXT[] NOT NULL DEFAULT '{}',
    properties       JSONB NOT NULL DEFAULT '{}',
    person_entity_id UUID,
    -- A user manually assigned this profile to its person; automation must
    -- never move it.
    pinned_by_user   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS person_profiles_owner_source_key_uniq
    ON ci.person_profiles (owner_user_id, source_system, remote_key);

CREATE INDEX IF NOT EXISTS person_profiles_person_idx
    ON ci.person_profiles (owner_user_id, person_entity_id);

-- Sticky user corrections (the old removed_contact_ids idea): facts the
-- promotion pipeline must never undo. Two shapes, distinguished by which
-- columns are set:
--   * person/person  — entity_id_a + entity_id_b (a < b), profile_id NULL:
--     "these two people are NOT the same" (rejected suggestion).
--   * profile/person — profile_id + entity_id_a, entity_id_b NULL:
--     "this profile does NOT belong to this person" (user detached it).
CREATE TABLE IF NOT EXISTS ci.person_distinctions (
    distinction_id UUID PRIMARY KEY,
    owner_user_id  UUID NOT NULL,
    entity_id_a    UUID NOT NULL,
    entity_id_b    UUID,
    profile_id     UUID,
    reason         TEXT NOT NULL DEFAULT 'user',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((entity_id_b IS NOT NULL) <> (profile_id IS NOT NULL)),
    CHECK (entity_id_b IS NULL OR entity_id_a < entity_id_b)
);

CREATE UNIQUE INDEX IF NOT EXISTS person_distinctions_pair_uniq
    ON ci.person_distinctions (owner_user_id, entity_id_a, entity_id_b)
    WHERE entity_id_b IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS person_distinctions_profile_uniq
    ON ci.person_distinctions (owner_user_id, profile_id, entity_id_a)
    WHERE profile_id IS NOT NULL;

-- Weak-signal (name-only) duplicate candidates. Never auto-merged: a user
-- confirms via mergePeople (-> accepted) or rejects (-> rejected + a
-- person_distinctions pair row). 'stale' marks suggestions invalidated by a
-- merge that consumed one of the endpoints.
CREATE TABLE IF NOT EXISTS ci.person_duplicate_suggestions (
    suggestion_id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL,
    entity_id_a   UUID NOT NULL,
    entity_id_b   UUID NOT NULL,
    confidence    REAL NOT NULL DEFAULT 0.5,
    -- What matched, for display/audit: e.g. {"kind":"name","value":"liam broza"}.
    signals       JSONB NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected', 'stale')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (entity_id_a < entity_id_b)
);

CREATE UNIQUE INDEX IF NOT EXISTS person_duplicate_suggestions_pair_uniq
    ON ci.person_duplicate_suggestions (owner_user_id, entity_id_a, entity_id_b);

CREATE INDEX IF NOT EXISTS person_duplicate_suggestions_pending_idx
    ON ci.person_duplicate_suggestions (owner_user_id, status)
    WHERE status = 'pending';

-- migrate:down
DROP INDEX IF EXISTS ci.person_duplicate_suggestions_pending_idx;
DROP INDEX IF EXISTS ci.person_duplicate_suggestions_pair_uniq;
DROP TABLE IF EXISTS ci.person_duplicate_suggestions;
DROP INDEX IF EXISTS ci.person_distinctions_profile_uniq;
DROP INDEX IF EXISTS ci.person_distinctions_pair_uniq;
DROP TABLE IF EXISTS ci.person_distinctions;
DROP INDEX IF EXISTS ci.person_profiles_person_idx;
DROP INDEX IF EXISTS ci.person_profiles_owner_source_key_uniq;
DROP TABLE IF EXISTS ci.person_profiles;
