-- migrate:up
-- Reviewable graph-enrichment proposals. `GraphEnrichmentService.ingestWithPersonalization`
-- calls `PersonalizationService.decideAction()` before writing LLM-extracted
-- preferences / family relations / general relations into the graph. When the
-- decision is 'review' (hands_off below its 0.7 auto-promote threshold, or
-- balanced/cautious on any graph connection — see GRAPH_CONNECTION_KINDS) the
-- batch that was about to be ingested was previously discarded outright:
-- nothing recorded what it would have written, so there was nothing for a
-- user to see or approve. This table is where that batch is filed instead.
--
-- ## Why a new table rather than an existing queue
--
-- ci.task_pending_changes requires a NOT NULL task_id (20260818185920) — a
-- graph-enrichment batch has no task to hang off. ci.merge_candidates is a
-- PAIR queue (entity_id_a/entity_id_b) and ci.entity_type_proposals concerns
-- ONE entity's retype; that migration's own comment (20260821223511) explains
-- in detail why neither shape fits a structured proposal, and the same
-- argument applies here — a batch of N new Concept/Person entities plus N
-- relationship edges fits none of them. ci.actions is a dismiss-only feed
-- card with no accept/reject lifecycle. So this follows entity_type_proposals'
-- contract instead: the enrichment PROPOSES, never applies; a human disposes.
--
-- ## Granularity: one row per ingestWithPersonalization call, not per item
--
-- decideAction is already called once per category (preferences, family
-- relations, general relations) over one confidence value for the whole
-- batch — that is the existing unit of decision GraphEnrichmentService uses
-- for the auto-apply path too. This table stores proposals at that same
-- granularity rather than inventing a per-item confidence that doesn't exist
-- today.
--
-- ## Why content_hash
--
-- extract-graph is user-triggered and explicitly re-runnable. Without a
-- dedupe key, running it twice over the same underlying data would file two
-- identical pending proposals. content_hash (sha256 of the entities +
-- relationships payload, key-sorted so field order never matters) lets a
-- re-run upsert onto the same row — refreshing confidence/evidence — while,
-- matching entity_type_proposals' rule, NEVER touching a status a human
-- already set.
CREATE TABLE IF NOT EXISTS ci.graph_enrichment_proposals (
    graph_enrichment_proposal_id uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    owner_user_id                uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,

    -- Which ingestWithPersonalization call produced this batch.
    category                     text NOT NULL,
    -- Dedupe key for a re-run of the same extraction; see note above.
    content_hash                 text NOT NULL,

    -- The exact bulkIngestGraph batch that was about to be written —
    -- GraphEntityInputDto[] / GraphRelationshipInputDto[] — so accepting a
    -- proposal later is a direct replay through GraphIngestService.ingest,
    -- not a re-derivation.
    entities                     jsonb NOT NULL DEFAULT '[]'::jsonb,
    relationships                jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Human-readable one-line-per-item descriptions (e.g. "PREFERS Italian
    -- (cuisine)", "SPOUSE: John Smith <-> Jane Smith") so a review UI can
    -- render the batch without knowing the entities/relationships JSON shape.
    evidence                     jsonb NOT NULL DEFAULT '[]'::jsonb,

    confidence                   double precision NOT NULL,
    status                       text NOT NULL DEFAULT 'pending',
    detected_by                  text NOT NULL DEFAULT 'graph_enrichment',

    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    resolved_at                  timestamptz,

    CONSTRAINT graph_enrichment_proposals_category   CHECK (category IN ('preference', 'family_relation', 'general_relation')),
    CONSTRAINT graph_enrichment_proposals_status      CHECK (status IN ('pending', 'accepted', 'rejected')),
    CONSTRAINT graph_enrichment_proposals_confidence  CHECK (confidence >= 0 AND confidence <= 1)
);

COMMENT ON TABLE ci.graph_enrichment_proposals IS
  'Graph-enrichment batches (preferences / family relations / general relations) that PersonalizationService.decideAction routed to review instead of auto-applying. The enrichment proposes; a human disposes via accept (replays the batch through GraphIngestService.ingest) or reject.';

-- Re-run of the same batch upserts onto this row and never touches status.
CREATE UNIQUE INDEX IF NOT EXISTS graph_enrichment_proposals_content_uniq
    ON ci.graph_enrichment_proposals (owner_user_id, category, content_hash);

-- The review queue's own read shape.
CREATE INDEX IF NOT EXISTS graph_enrichment_proposals_review_idx
    ON ci.graph_enrichment_proposals (owner_user_id, status, created_at DESC);

-- migrate:down
DROP INDEX IF EXISTS ci.graph_enrichment_proposals_review_idx;
DROP INDEX IF EXISTS ci.graph_enrichment_proposals_content_uniq;
DROP TABLE IF EXISTS ci.graph_enrichment_proposals;
