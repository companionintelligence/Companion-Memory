-- migrate:up
-- Reviewable proposals to RETYPE an entity, written by `EntityTypeAuditCron`.
--
-- ## Why a table exists at all
--
-- Entity retyping has been done by hand-written one-off migrations: six landed
-- in 48 hours (20260818220731, 20260819002002, 20260819055246, 20260819092314,
-- 20260819145023, 20260819150902). The classification rule those migrations
-- restate in SQL is already shared code -- `isShortCode` in
-- `domains/import/staging/identity.ts`, read by the iMessage and Google Voice
-- parsers -- and nothing re-applies it to rows already in `ci.entities`. So a
-- parser fix repairs the next import and leaves the corpus, and the repair is a
-- migration somebody has to write, by hand, again.
--
-- This table is where the standing job files what it finds. It PROPOSES; a
-- human disposes. Nothing here applies anything.
--
-- ## Why not ci.merge_candidates
--
-- Structurally impossible, not merely a poor fit. That table is a PAIR queue:
-- `entity_id_a`/`entity_id_b` with `CHECK (entity_id_a < entity_id_b)` and a
-- unique index over the ordered pair. A mis-type concerns ONE entity and has no
-- second entity to name, so every row here would have to invent one; and the
-- executors that table feeds (`ObjectMergeService.mergeObjects`, the person
-- merge) collapse two rows into one, which is the wrong operation entirely.
--
-- ## Why not ci.actions
--
-- `ci.actions` is a feed CARD: title/text plus `seen` and `dismissed`. It has no
-- pending/accepted/rejected lifecycle, so "the user rejected this retype" would
-- be indistinguishable from "the user swiped the card away"; it has no
-- uniqueness key, so a weekly cron would mint a fresh card per entity per week
-- forever; and it has nowhere structured to carry `proposed_linked_id`, which
-- (see below) is half the proposal. Cards are how a person is TOLD; they are not
-- a queue with a decision on it.
--
-- What this table borrows from `ci.merge_candidates` is its contract, verbatim:
-- re-detection rescores `score`/`evidence` and never touches `status`, so a pair
-- -- here, a row -- a human rejected stays rejected.
--
-- ## Why the proposal carries a linked_id as well as a type
--
-- A type change MOVES the natural key. `naturalKeyFor` (push/entities.ts) folds
-- the staged type into the key and `GraphIngestService` derives
-- `linked_id = uuidv5(key, IMPORT_NAMESPACE)` from it, so the same short code
-- that keyed `contact:411` before a parser fix keys `short_code:411` after it.
-- Retyping without re-keying heals the corpus and lets the very next import
-- re-break it: the fixed parser resolves no existing row and mints a SECOND
-- entity for a code that already has one. 20260819150902 says this in full.
-- A proposal that named only the type would therefore be a proposal to create a
-- duplicate, so `proposed_linked_id` and `proposed_natural_key` are NOT NULL.
--
-- ## Why the search-index consequence is a column
--
-- A retype OUT of `Person` orphans the person search index. The embed and vector
-- sweeps select `entity_type = 'Person' AND merged_into_entity_id IS NULL`
-- (`pipeline/stages/index/entityEmbedStages.ts`, mirrored in `entityRows.ts`), so
-- the moment the row stops being a Person they stop seeing it -- they will
-- neither refresh its index rows nor notice they exist. `ci_search.vectors` is
-- the search CANDIDATE source, so those rows would answer person searches
-- forever, pointing at something that is no longer a person: exactly the harm
-- the retype exists to end, surviving it.
--
-- `search_index_action` is therefore derived from the TYPE TRANSITION, not from
-- today's counts -- an apply that runs a week after detection must purge whether
-- or not the index happened to be empty when the proposal was filed.
-- `search_index_rows` is the observation, kept so the claim is checkable.
CREATE TABLE IF NOT EXISTS ci.entity_type_proposals (
    entity_type_proposal_id uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    owner_user_id           uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    entity_id               uuid NOT NULL REFERENCES ci.entities(entity_id) ON DELETE CASCADE,

    current_entity_type     text NOT NULL,
    proposed_entity_type    text NOT NULL,
    -- The coordinate halves. `current_linked_id` is nullable because
    -- ci.entities.linked_id is; the proposed one never is -- a proposal without
    -- it is a proposal to mint a duplicate.
    current_linked_id       uuid,
    proposed_linked_id      uuid NOT NULL,
    proposed_natural_key    text NOT NULL,
    linked_table            text,

    -- A row already sitting at the proposed coordinate: the apply must MERGE
    -- rather than re-key, because `entities_linked_uniq` would refuse the
    -- second occupant. Set when found; capped below the autonomy floor so no
    -- trust mode can pre-authorise it.
    conflicting_entity_id   uuid,

    -- 'purge_person_index' | 'none'. Not a CHECK against a fixed list beyond
    -- those two: the vocabulary is a code constant and adding one is a code
    -- change, not a migration.
    search_index_action     text NOT NULL,
    -- Rows observed at detection time, per table, so the proposal's claim about
    -- the index is auditable rather than asserted.
    search_index_rows       jsonb NOT NULL DEFAULT '{}'::jsonb,

    score                   double precision NOT NULL,
    -- What the trust dial returned for this proposal at detection time:
    -- 'review' (a human must approve) or 'auto' (a `hands_off` appliance has
    -- pre-authorised it). Recorded, not acted on -- see the note below.
    autonomy                text NOT NULL,
    evidence                jsonb NOT NULL DEFAULT '[]'::jsonb,
    status                  text NOT NULL DEFAULT 'pending',
    detected_by             text NOT NULL,
    detector_version        integer NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT entity_type_proposals_moves_type  CHECK (proposed_entity_type <> current_entity_type),
    CONSTRAINT entity_type_proposals_status      CHECK (status IN ('pending', 'accepted', 'rejected')),
    CONSTRAINT entity_type_proposals_autonomy    CHECK (autonomy IN ('review', 'auto')),
    CONSTRAINT entity_type_proposals_index_act   CHECK (search_index_action IN ('purge_person_index', 'none')),
    CONSTRAINT entity_type_proposals_score_check CHECK (score > 0 AND score <= 1)
);

COMMENT ON TABLE ci.entity_type_proposals IS
  'Proposed entity retypes awaiting human review. The audit proposes; it never retypes. A proposal carries BOTH the new entity_type and the new linked_id, because a type change moves the natural key.';

-- One open proposal per entity, which is what makes a weekly re-run a rescore
-- rather than a pile. The detector upserts on this key and updates everything
-- EXCEPT `status`.
CREATE UNIQUE INDEX IF NOT EXISTS entity_type_proposals_entity_uniq
    ON ci.entity_type_proposals (owner_user_id, entity_id);

-- The review queue's own read shape.
CREATE INDEX IF NOT EXISTS entity_type_proposals_review_idx
    ON ci.entity_type_proposals (owner_user_id, status, score DESC);

-- The audit's window ordering: least-recently-proposed first, so a run that hits
-- its per-run cap resumes where the last one stopped instead of re-walking the
-- same head of the table.
CREATE INDEX IF NOT EXISTS entity_type_proposals_updated_at_idx
    ON ci.entity_type_proposals (updated_at);

-- migrate:down
DROP INDEX IF EXISTS ci.entity_type_proposals_updated_at_idx;
DROP INDEX IF EXISTS ci.entity_type_proposals_review_idx;
DROP INDEX IF EXISTS ci.entity_type_proposals_entity_uniq;
DROP TABLE IF EXISTS ci.entity_type_proposals;
