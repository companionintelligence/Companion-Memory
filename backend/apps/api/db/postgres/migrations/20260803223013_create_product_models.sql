-- migrate:up
-- The catalog half of the product/instance split.
--
-- `ci.inventory` rows are OWNED UNITS ("the iPhone on my desk, serial F2LX…,
-- cracked screen"). A product model is the thing a GTIN names ("iPhone 15 Pro
-- 256GB Blue Titanium"). Today buying three of the same headphones produces
-- three unrelated ci.inventory rows with the brand/model strings duplicated
-- three times and nowhere to hang the canonical barcode, spec sheet, MSRP,
-- manual or stock image. Worse, `ci.inventory.identifier_codes` — the JSONB bag
-- the importer has been writing ASINs into since 2025-09 — is not indexed, not
-- exposed on any API, and read by nothing, so there has never been a way to ask
-- "what do I own with this barcode?". This table plus ci.object_identifiers is
-- that home.
--
-- Deliberately user-scoped like every other ci.* table. A future SHARED catalog
-- would arrive as owner_user_id IS NULL rows plus an OR-NULL read predicate; do
-- NOT pre-build that — a half-built sharing model is worse than none.
CREATE TABLE IF NOT EXISTS ci.product_models (
    product_id             UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id                UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    owner_user_id          UUID REFERENCES ci.users(id) ON DELETE SET NULL,
    -- Graph mirror (ci.entities.entity_type = 'Product'). Written lazily by
    -- ObjectGraphLinkService on user-facing paths, never on bulk ingest — bulk
    -- stays event-free for throughput and a maintenance sweep backfills.
    product_entity_id      UUID REFERENCES ci.entities(entity_id),

    title                  TEXT NOT NULL,
    brand                  TEXT,
    manufacturer           TEXT,
    model_number           TEXT,
    category               TEXT,
    subcategory            TEXT,
    product_type           TEXT,
    description            TEXT,
    -- {color: 'Blue Titanium', capacity: '256GB', size: 'M'}. Kept separate from
    -- `spec` so variant axes (which distinguish two models) never mix with
    -- descriptive specs (which do not).
    variant_attributes     JSONB NOT NULL DEFAULT '{}',
    spec                   JSONB NOT NULL DEFAULT '{}',

    -- Money as integer MINOR UNITS + ISO-4217, not DECIMAL(10,2). Two reasons:
    -- DECIMAL(10,2) cannot represent JPY (0 minor digits) or KWD (3) honestly,
    -- and node-postgres hands `numeric` back as a STRING with no TypeORM
    -- transformer — so ci.inventory.purchase_price is a string at runtime while
    -- its entity says `number`. The existing DECIMAL columns keep their shape
    -- for backward compatibility; everything new uses minor units.
    msrp_minor             BIGINT,
    currency               TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),

    -- Stock/product imagery as ci.content row ids. No FK: content is purgeable
    -- (see the /v1/contents/lookup purged-media reconcile path), so a hard FK
    -- would block a purge or resurrect dead pointers.
    image_content_id       UUID,
    manual_content_ids     UUID[],

    is_digital             BOOLEAN NOT NULL DEFAULT FALSE,
    identity_confidence    REAL NOT NULL DEFAULT 1.0
                             CHECK (identity_confidence > 0 AND identity_confidence <= 1),
    -- Merge tombstone, same contract as ci.entities.merged_into_entity_id from
    -- 20260803211455: non-NULL means this row lost a merge and reads must follow
    -- the pointer. Every read path filters IS NULL.
    merged_into_product_id UUID REFERENCES ci.product_models(product_id) ON DELETE SET NULL,

    metadata               JSONB NOT NULL DEFAULT '{}',
    source_type            TEXT,
    source_system          TEXT,
    source_id              TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ci.product_models IS
  'Catalog product models — the thing a GTIN names. ci.inventory holds the owned UNITS that are instances of these.';
COMMENT ON COLUMN ci.product_models.identity_confidence IS
  '1.0 = user-entered or barcode-scanned. 0.85 = structured feed. 0.7 = OCR/receipt-derived. 0.4 = LLM-guessed from a photo. 1.0 reads as ground truth to HBPE/RAG — never write it for an inferred row.';
COMMENT ON COLUMN ci.product_models.merged_into_product_id IS
  'Merge tombstone. Non-NULL means this row lost a merge; follow the pointer to the canonical model. Mirrors ci.entities.merged_into_entity_id (#1810).';
COMMENT ON COLUMN ci.product_models.msrp_minor IS
  'Integer minor units of `currency` (cents for USD, yen for JPY). NOT decimal — see the table header.';

-- Ingest idempotency: the platform-standard provenance triple, same shape and
-- same partial predicate as inventory_source_triple_uniq (20260623120000), so
-- bulkInsertIdempotent works unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS product_models_source_triple_uniq
    ON ci.product_models (owner_user_id, source_type, source_system, source_id)
    WHERE source_id IS NOT NULL;

-- Identity-by-normalized-attribute, so two importers naming the same product
-- converge without needing a shared external id. Tombstoned rows are excluded
-- from the predicate, which frees their slot for the surviving row.
CREATE UNIQUE INDEX IF NOT EXISTS product_models_brand_model_uniq
    ON ci.product_models (owner_user_id, lower(btrim(brand)), lower(btrim(model_number)))
    WHERE brand IS NOT NULL AND model_number IS NOT NULL AND merged_into_product_id IS NULL;

CREATE INDEX IF NOT EXISTS product_models_user_idx
    ON ci.product_models (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_models_brand_idx
    ON ci.product_models (owner_user_id, lower(btrim(brand))) WHERE brand IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_models_category_idx
    ON ci.product_models (category, subcategory) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_models_entity_idx
    ON ci.product_models (product_entity_id) WHERE product_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_models_merged_idx
    ON ci.product_models (merged_into_product_id) WHERE merged_into_product_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.product_models_merged_idx;
DROP INDEX IF EXISTS ci.product_models_entity_idx;
DROP INDEX IF EXISTS ci.product_models_category_idx;
DROP INDEX IF EXISTS ci.product_models_brand_idx;
DROP INDEX IF EXISTS ci.product_models_user_idx;
DROP INDEX IF EXISTS ci.product_models_brand_model_uniq;
DROP INDEX IF EXISTS ci.product_models_source_triple_uniq;
DROP TABLE IF EXISTS ci.product_models;
