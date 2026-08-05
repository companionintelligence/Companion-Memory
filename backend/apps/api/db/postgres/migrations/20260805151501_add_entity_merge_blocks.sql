-- migrate:up
-- Negative assertions for entity merging: "these two are NOT the same thing".
--
-- Duplicate detection is derived, not stored — PersonDuplicateService recomputes
-- its groups from scratch on every call by unnesting identifiers and grouping on
-- the shared value. That makes it self-healing, and it also means a rejection
-- has nowhere to live: a user who says "no, those are two different Dana
-- Whitmores" is shown the same pair again on the next page load, forever.
--
-- This table is the memory of that decision. It is deliberately entity-agnostic
-- (no entity_type column, nothing Person-specific) because the same problem
-- arrives for Location and Object as soon as they get duplicate detection of
-- their own; the pair of ids is the whole assertion.
--
-- It also has to exist BEFORE unmerge does. Reverting a merge with nothing to
-- record the reversal just leaves the pair looking like a duplicate again, and
-- once tier-1 auto-merge lands the system would silently re-perform the merge
-- the user had only just undone.
CREATE TABLE IF NOT EXISTS ci.entity_merge_blocks (
    block_id      UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    owner_user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,

    -- No FKs on the entity columns: ci.entities is deliberately FK-less
    -- (20260127185821_remove_relationship_foreign_keys_to_entities), and the
    -- block must outlive a hard delete of either row.
    entity_id_a   UUID NOT NULL,
    entity_id_b   UUID NOT NULL,

    -- 'user_rejected' | 'unmerged' | future automated sources.
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Stored as an ORDERED pair so (A,B) and (B,A) are one row and one lookup.
    -- Without this the unique index below would happily hold both directions and
    -- every read would have to check two orderings.
    CONSTRAINT entity_merge_blocks_ordered CHECK (entity_id_a < entity_id_b)
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_merge_blocks_pair_uniq
    ON ci.entity_merge_blocks (owner_user_id, entity_id_a, entity_id_b);

-- The read is "which of these candidate pairs are blocked?" over the handful of
-- ids in one duplicate sweep, so both endpoints need to be searchable.
CREATE INDEX IF NOT EXISTS entity_merge_blocks_a_idx
    ON ci.entity_merge_blocks (owner_user_id, entity_id_a);
CREATE INDEX IF NOT EXISTS entity_merge_blocks_b_idx
    ON ci.entity_merge_blocks (owner_user_id, entity_id_b);

COMMENT ON TABLE ci.entity_merge_blocks IS
  'Pairs the user has declared distinct. Duplicate detection filters against this so a rejected suggestion is never re-proposed, and unmerge records one so a reversal is not undone by the next sweep.';

-- migrate:down
DROP INDEX IF EXISTS ci.entity_merge_blocks_b_idx;
DROP INDEX IF EXISTS ci.entity_merge_blocks_a_idx;
DROP INDEX IF EXISTS ci.entity_merge_blocks_pair_uniq;
DROP TABLE IF EXISTS ci.entity_merge_blocks;
