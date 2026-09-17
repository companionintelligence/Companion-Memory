-- migrate:up

-- ═══════════════════════════════════════════════════════════════════════════
-- The tag taxonomy CI-Planning ported in, and the axis it must not be
-- confused with.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PR #2552 landed the tagging BRIDGE -- 'task' joined `TAGGABLE_ENTITIES`,
-- `TaskType implements Taggable`, tasks resolve through `TagResolver` -- but
-- `ci_search.tags` / `ci_search.entity_tag` stayed exactly the flat label
-- store they were before planning existed. This migration is the taxonomy
-- itself: the direction/intention/category hierarchy CI-Planning's Tags
-- manager and Balance view are built on
-- (CI-Planning `server/src/db/schema.ts`, `tags` / `tag_directions` /
-- `tag_categories` / `category_direction_optouts` / `entity_categories`,
-- migrations 0036/0043/0069/0134), named as the target shape in this repo's
-- own `docs/architecture/planning-roadmap.md` (Object model, "Taxonomy" row).
--
-- ── Two axes. Orthogonal. Do not conflate them. ────────────────────────────
--
-- `tags.kind` is the taxonomy LEVEL a tag sits at:
--   * 'direction'  -- brand-set Home/Work/Community (`is_base`, undeletable)
--                      plus any the user adds. A top-level grouping.
--   * 'intention'  -- everything else; groups under 0+ directions via
--                      `tag_directions`, and 0+ categories via `tag_categories`.
--   * 'category'   -- a SECOND, orthogonal grouping over intentions (the six
--                      Balance dimensions), with its own per-direction scope
--                      (`category_direction_optouts`).
-- NULL means untyped -- every tag that exists before this migration runs,
-- since nothing before now ever assigned a kind.
--
-- `entity_tag.level` is a COMPLETELY different thing: a per-*entity* dilution
-- weight (1 = primary, >1 = secondary) for downstream scoring. It says
-- nothing about the tag itself and has no relationship to `kind` -- a
-- direction tag applied at level 2 is still a direction, just a secondary one
-- on that entity. CI-Planning's own `services/tags.ts` carries this exact
-- warning verbatim because the two are so easy to reach for interchangeably.
--
-- ── Why `entity_categories` is its own table, not a third `entity_tag` kind ─
--
-- `TagService.getTagsForEntity` is the read every existing consumer of tags
-- goes through (`TagLoader` -> `TaskType.tags`, the explorer's tag facets,
-- `TagResolver.entities`). It selects from `entity_tag` alone. If categories
-- were just another row shape in `entity_tag`, every one of those callers
-- would start seeing category tags mixed into what today is a flat, uniform
-- list of labels -- a behaviour change to a contract this milestone is
-- explicitly not allowed to touch. Keeping categories in their own table,
-- exactly as CI-Planning's `entity_categories` does (0134: "kept SEPARATE
-- from entity_tags on purpose -- the 'categories never enter entity_tags'
-- invariant holds"), means `getTagsForEntity`'s query is untouched and its
-- result set cannot change no matter what this migration adds elsewhere.
--
-- Naming departure from the milestone brief worth flagging: CI-Planning calls
-- its ordering column `position` (0-based, capped at 3 rows/entity by the
-- service layer, never in SQL), not `level` -- and this migration keeps that
-- name rather than reusing `level`, precisely BECAUSE `entity_tag.level`
-- already means something else on this same conceptual axis (per-entity
-- weight vs. per-entity display order). Calling both columns `level` would
-- recreate, inside one schema, the exact ambiguity this migration's own
-- header is at pains to rule out.
--
-- ── Opt-out polarity on `category_direction_optouts` ──────────────────────
--
-- A row means "this category tag does NOT apply under this direction tag";
-- no row for a (category, direction) pair means it DOES apply. Every
-- existing category (there are none yet -- `kind` is new) and every
-- direction added in the future is on by default with zero backfill, which
-- is the entire reason for choosing this polarity over an opt-IN table that
-- would need a row inserted for every direction a category should cover,
-- including ones that do not exist yet. Precedent: `tags.muted` uses the same
-- absent-means-default-on shape.
--
-- ── Why no seeded rows here ─────────────────────────────────────────────────
--
-- `ci_search.tags` carries `user_id uuid NOT NULL` -- it has been per-user
-- since it was created (`20251216180819_migrate_tags_to_ci_search.sql`),
-- unlike CI-Planning's `tags` table, which was single-owner when its base
-- directions were first seeded directly in migration 0036 and only later
-- grew multi-tenancy on top. A blanket `INSERT ... SELECT id FROM ci.users`
-- here would mint three direction rows for every current user with no
-- accompanying UI, onboarding step, or way for a user who signs up tomorrow
-- to get the same three rows -- seeding a fixed user set in a schema
-- migration is the wrong tool for a per-user default. Base-direction creation
-- belongs in a service (onboarding, or a lazy "ensure base directions" call
-- the taxonomy UI makes on first visit) added alongside whatever consumes
-- `is_base`, which is deliberately out of scope for this migration.

ALTER TABLE ci_search.tags
    ADD COLUMN kind text,
    ADD COLUMN muted boolean NOT NULL DEFAULT false,
    ADD COLUMN is_base boolean NOT NULL DEFAULT false;

ALTER TABLE ci_search.tags
    ADD CONSTRAINT tags_kind_check
        CHECK (kind IS NULL OR kind IN ('direction', 'intention', 'category'));

COMMENT ON COLUMN ci_search.tags.kind IS
  'Taxonomy level: NULL (untyped, every pre-existing tag) | direction | intention | category. Orthogonal to entity_tag.level -- see this migration''s header.';
COMMENT ON COLUMN ci_search.tags.muted IS
  'Set-aside flag: excluded from what the app volunteers on its own (suggestions/auto-tag), never from what a user can still apply or from any read path. Default false so every existing tag stays fully live.';
COMMENT ON COLUMN ci_search.tags.is_base IS
  'Brand-set direction (Home/Work/Community), undeletable. Default false for every existing tag; nothing in this migration mints a base direction -- see the header note on seeding.';

-- `entity_tag.level`: per-entity dilution weight, 1 = primary (matches every
-- existing row -- the column did not exist for them to disagree with),
-- >1 = secondary. A constant default on a NOT NULL column is a metadata-only
-- change in Postgres 11+; no table rewrite, no lock beyond the ALTER itself.
ALTER TABLE ci_search.entity_tag
    ADD COLUMN level smallint NOT NULL DEFAULT 1;

ALTER TABLE ci_search.entity_tag
    ADD CONSTRAINT entity_tag_level_check CHECK (level >= 1);

COMMENT ON COLUMN ci_search.entity_tag.level IS
  'Per-entity dilution weight for downstream scoring (1 = primary, >1 = secondary). Unrelated to tags.kind -- see this migration''s header.';

-- intention -> direction membership. An intention with no row here is
-- "Unsorted"; both sides cascade so deleting either tag drops the membership
-- automatically (unlike entity_tag_tag_id_fkey, which carries no ON DELETE
-- rule and needs app-level cleanup -- these do not).
CREATE TABLE ci_search.tag_directions (
    intention_tag_id uuid NOT NULL REFERENCES ci_search.tags (id) ON DELETE CASCADE,
    direction_tag_id uuid NOT NULL REFERENCES ci_search.tags (id) ON DELETE CASCADE,

    CONSTRAINT tag_directions_pkey PRIMARY KEY (intention_tag_id, direction_tag_id)
);

-- Postgres does not index the referencing side of a FK (see
-- 20260819013739's note on entity_tag_tag_id_fkey for the same gap): the
-- composite PK above only serves lookups led by intention_tag_id, not "which
-- intentions sit under this direction" or a cascade delete of a direction tag.
CREATE INDEX tag_directions_direction_tag_id_idx ON ci_search.tag_directions (direction_tag_id);

-- intention -> category membership. A verbatim mirror of tag_directions on
-- the second grouping axis; an intention with no row here is "Unsorted" on
-- the category (Balance) view.
CREATE TABLE ci_search.tag_categories (
    intention_tag_id uuid NOT NULL REFERENCES ci_search.tags (id) ON DELETE CASCADE,
    category_tag_id  uuid NOT NULL REFERENCES ci_search.tags (id) ON DELETE CASCADE,

    CONSTRAINT tag_categories_pkey PRIMARY KEY (intention_tag_id, category_tag_id)
);

CREATE INDEX tag_categories_category_tag_id_idx ON ci_search.tag_categories (category_tag_id);

-- Per-category direction SCOPE, opt-out polarity (see header). A row = this
-- direction is OFF for this category; absent = on.
CREATE TABLE ci_search.category_direction_optouts (
    category_tag_id  uuid NOT NULL REFERENCES ci_search.tags (id) ON DELETE CASCADE,
    direction_tag_id uuid NOT NULL REFERENCES ci_search.tags (id) ON DELETE CASCADE,

    CONSTRAINT category_direction_optouts_pkey PRIMARY KEY (category_tag_id, direction_tag_id)
);

CREATE INDEX category_direction_optouts_direction_tag_id_idx
    ON ci_search.category_direction_optouts (direction_tag_id);

-- A taggable entity's 1-3 categories, position-ordered (0-based; the cap and
-- the ordering are enforced in TagService, exactly as entity_tag's own
-- integrity is app-enforced -- see the next paragraph). Column types/naming
-- for entity_type/entity_id match ci_search.entity_tag exactly, on purpose:
-- same "which taggable entity" identity, same lack of a single table an FK
-- could target.
--
-- No FK on (entity_type, entity_id), for the same reason entity_tag has none:
-- entity_id spans every taggable entity type (`ci_search.entity_tag` in
-- backend/apps/api/src/domains/search-next spells out why in its own header),
-- most of which are not one single table a foreign key could reference.
-- category_tag_id DOES FK ci_search.tags(id) ON DELETE CASCADE, so deleting a
-- category tag drops every entity's assignment of it without app-level
-- cleanup -- TagService.remove still owns entity_tag's manual purge because
-- that FK has no ON DELETE rule, but has nothing to do here for this table.
CREATE TABLE ci_search.entity_categories (
    entity_type    text        NOT NULL,
    entity_id      uuid        NOT NULL,
    category_tag_id uuid       NOT NULL REFERENCES ci_search.tags (id) ON DELETE CASCADE,
    position       smallint    NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT entity_categories_pkey PRIMARY KEY (entity_type, entity_id, category_tag_id)
);

CREATE INDEX entity_categories_category_tag_id_idx ON ci_search.entity_categories (category_tag_id);

COMMENT ON TABLE ci_search.entity_categories IS
  'A taggable entity''s 1-3 categories, position-ordered. Deliberately separate from ci_search.entity_tag so TagService.getTagsForEntity''s query -- and every existing reader downstream of it -- is untouched by this table existing.';
COMMENT ON COLUMN ci_search.entity_categories.position IS
  'Display/priority order among an entity''s categories (0-based). Named position, not level, so it cannot be mistaken for entity_tag.level (a different axis entirely -- see this migration''s header).';

-- migrate:down

DROP TABLE IF EXISTS ci_search.entity_categories;
DROP TABLE IF EXISTS ci_search.category_direction_optouts;
DROP TABLE IF EXISTS ci_search.tag_categories;
DROP TABLE IF EXISTS ci_search.tag_directions;

ALTER TABLE ci_search.entity_tag
    DROP CONSTRAINT IF EXISTS entity_tag_level_check,
    DROP COLUMN IF EXISTS level;

ALTER TABLE ci_search.tags
    DROP CONSTRAINT IF EXISTS tags_kind_check,
    DROP COLUMN IF EXISTS kind,
    DROP COLUMN IF EXISTS muted,
    DROP COLUMN IF EXISTS is_base;
