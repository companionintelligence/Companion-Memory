-- migrate:up
-- A SIGHTING of a physical thing — the image half of object identification.
--
-- The gap this closes: CvDetectionsCapturedEvent has a listener
-- (CvDetectionsListener) whose `case 'Thing'` branch is empty, and
-- InventoryListener writes speculative ci.inventory rows straight from a vision
-- guess. That conflates two different claims — "a coffee mug is visible in this
-- photo" and "I own this specific coffee mug" — and pollutes the owned-things
-- table with every object that ever appeared in frame.
--
-- An observation is the weak claim: something was seen, at a time, in an image,
-- ideally at a known place. Resolution to an owned unit (resolved_object_id) or
-- a catalog product (resolved_product_id) is a SEPARATE, revisable decision
-- carrying its own method and confidence. Nothing here ever writes ci.inventory
-- directly; ObjectResolutionService mints only above the configured
-- auto-mint confidence, and everything below it queues for user review.
--
-- The place link is what makes this tractable. A detection labelled "mug" at
-- home resolves against the small set of things known to live at home; the same
-- label in a café resolves to nothing and stays an observation. That prior is
-- the whole reason place_entity_id is on this table and indexed.
CREATE TABLE IF NOT EXISTS ci.object_observations (
    observation_id        UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id               UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    owner_user_id         UUID REFERENCES ci.users(id) ON DELETE SET NULL,

    observed_at           TIMESTAMPTZ NOT NULL,
    source_kind           TEXT NOT NULL DEFAULT 'photo'
                            CHECK (source_kind IN ('photo', 'video_frame', 'live_camera', 'screenshot', 'manual')),

    -- Where the pixels live. No FKs — content and files are purgeable, so a hard
    -- FK would block a purge or resurrect a dead pointer (same rule as
    -- ci.receipts.document_content_id).
    content_id            UUID,
    file_id               UUID,
    event_id              UUID REFERENCES ci.events(event_id) ON DELETE SET NULL,

    -- KNOWN PLACE. The strongest available prior for resolving a label to an
    -- owned thing; see the table header.
    place_entity_id       UUID REFERENCES ci.entities(entity_id) ON DELETE SET NULL,
    location_coordinates  GEOGRAPHY(POINT, 4326),

    -- What the detector said, verbatim. Always present — an observation with no
    -- label carries no information.
    label                 TEXT NOT NULL,
    label_source          TEXT CHECK (label_source IS NULL OR label_source IN ('yolo', 'ollama_vision', 'clip', 'user', 'import')),
    detector              TEXT,
    detector_version      TEXT,
    detection_confidence  REAL CHECK (detection_confidence IS NULL OR (detection_confidence >= 0 AND detection_confidence <= 1)),
    -- Normalized {x, y, w, h} in 0..1 of the source image, origin top-left.
    bbox                  JSONB,
    -- Cropped region persisted as its own ci.content row, so the review UI can
    -- show the thing rather than the whole photo. No FK, as above.
    crop_content_id       UUID,

    -- Visual embedding of the crop, for nearest-neighbour matching against
    -- other observations of the same object. 768 dims to match every other
    -- vector column in the schema (ci.entities.embedding, ci.inventory.object_embedding).
    embedding             vector(768),

    -- RESOLUTION — revisable, and deliberately separate from detection.
    resolved_object_id    UUID REFERENCES ci.inventory(object_id) ON DELETE SET NULL,
    resolved_product_id   UUID REFERENCES ci.product_models(product_id) ON DELETE SET NULL,
    resolution_method     TEXT NOT NULL DEFAULT 'none'
                            CHECK (resolution_method IN ('identifier', 'embedding', 'place_prior', 'label', 'user', 'none')),
    resolution_confidence REAL CHECK (resolution_confidence IS NULL OR (resolution_confidence >= 0 AND resolution_confidence <= 1)),
    -- TRUE only when a human confirmed it. Never set by a detector or an LLM —
    -- it is the flag that distinguishes ground truth from a good guess, and
    -- downstream consumers (HBPE, RAG) are entitled to rely on that.
    confirmed_by_user     BOOLEAN NOT NULL DEFAULT FALSE,

    -- Observed state: {color: 'red', condition: 'scratched', count: 2}.
    attributes            JSONB NOT NULL DEFAULT '{}',

    -- Idempotency arbiter for DETECTOR-generated rows, which carry no
    -- provenance triple: a stable digest of (content_id, detector, rounded bbox)
    -- computed by ObjectObservationService. Re-running the same detector over
    -- the same image must update in place, not duplicate. Imported observations
    -- use the source triple below instead; a row has one arbiter or the other.
    detection_key         TEXT,

    metadata              JSONB NOT NULL DEFAULT '{}',
    source_type           TEXT,
    source_system         TEXT,
    source_id             TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ci.object_observations IS
  'A sighting of a physical thing in an image. The weak claim ("seen"), kept separate from the strong one ("owned", ci.inventory) so vision guesses never pollute the owned-things table.';
COMMENT ON COLUMN ci.object_observations.place_entity_id IS
  'Graph Location the sighting happened at. The place_prior resolution step scopes candidate objects to things known to be at this place.';
COMMENT ON COLUMN ci.object_observations.confirmed_by_user IS
  'TRUE only after a human confirms. Never written by a detector or an LLM.';
COMMENT ON COLUMN ci.object_observations.detection_key IS
  'Stable digest of (content_id, detector, rounded bbox) — the idempotency arbiter for detector-generated rows, which have no provenance triple.';

-- Two arbiters, two partial unique indexes; a row satisfies exactly one.
CREATE UNIQUE INDEX IF NOT EXISTS object_observations_source_triple_uniq
    ON ci.object_observations (owner_user_id, source_type, source_system, source_id)
    WHERE source_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS object_observations_detection_key_uniq
    ON ci.object_observations (owner_user_id, detection_key)
    WHERE detection_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS object_observations_user_time_idx
    ON ci.object_observations (user_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS object_observations_object_idx
    ON ci.object_observations (resolved_object_id) WHERE resolved_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS object_observations_product_idx
    ON ci.object_observations (resolved_product_id) WHERE resolved_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS object_observations_place_idx
    ON ci.object_observations (place_entity_id) WHERE place_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS object_observations_content_idx
    ON ci.object_observations (content_id) WHERE content_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS object_observations_geo_idx
    ON ci.object_observations USING GIST (location_coordinates)
    WHERE location_coordinates IS NOT NULL;
-- Review queue: unresolved or unconfirmed sightings, oldest first.
CREATE INDEX IF NOT EXISTS object_observations_review_idx
    ON ci.object_observations (user_id, observed_at DESC)
    WHERE NOT confirmed_by_user AND resolved_object_id IS NULL;

-- Nearest-neighbour matching over crop embeddings. HNSW with cosine distance,
-- matching the ci_search.embeddings convention. Recall is governed by
-- hnsw.ef_search at query time, not by this index.
CREATE INDEX IF NOT EXISTS object_observations_embedding_hnsw_idx
    ON ci.object_observations USING hnsw (embedding vector_cosine_ops);

-- migrate:down
DROP INDEX IF EXISTS ci.object_observations_embedding_hnsw_idx;
DROP INDEX IF EXISTS ci.object_observations_review_idx;
DROP INDEX IF EXISTS ci.object_observations_geo_idx;
DROP INDEX IF EXISTS ci.object_observations_content_idx;
DROP INDEX IF EXISTS ci.object_observations_place_idx;
DROP INDEX IF EXISTS ci.object_observations_product_idx;
DROP INDEX IF EXISTS ci.object_observations_object_idx;
DROP INDEX IF EXISTS ci.object_observations_user_time_idx;
DROP INDEX IF EXISTS ci.object_observations_detection_key_uniq;
DROP INDEX IF EXISTS ci.object_observations_source_triple_uniq;
DROP TABLE IF EXISTS ci.object_observations;
