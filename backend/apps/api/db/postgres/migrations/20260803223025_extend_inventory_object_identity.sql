-- migrate:up
-- Wire ci.inventory into the object-identity model built by the four preceding
-- migrations, WITHOUT touching any of its 43 existing columns.
--
-- ci.inventory stays the table of record for OWNED UNITS. What it lacked was:
--   * a link to the catalog model it is an instance of (ci.product_models),
--   * a link to the purchase line it came from (ci.receipt_line_items),
--   * an honest lifecycle beyond the two disposal columns that have existed
--     since 2025-09 with no producer,
--   * a merge tombstone, so two rows discovered to be the same physical object
--     can be reconciled the way People were in #1810,
--   * a confidence, so a barcode-scanned unit and a vision-guessed one are
--     distinguishable to HBPE and RAG.
--
-- Note ci.inventory.object_entity_id ALREADY EXISTS (added by the original
-- 20250925154200 create) and is indexed — it is simply unmapped in ItemEntity.
-- That is an entity-side fix, not a schema one; no ALTER for it here.
ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES ci.product_models(product_id) ON DELETE SET NULL;

ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS acquisition_receipt_id UUID REFERENCES ci.receipts(receipt_id) ON DELETE SET NULL;

ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS acquisition_line_item_id UUID REFERENCES ci.receipt_line_items(line_item_id) ON DELETE SET NULL;

-- Supersedes the disposed_at/disposal_method pair as the queryable state. Those
-- columns are NOT dropped — they hold the when and the how, and dropping them
-- would break ItemEntity mappings that already exist.
ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active';

ALTER TABLE ci.inventory
    DROP CONSTRAINT IF EXISTS inventory_lifecycle_state_check;
ALTER TABLE ci.inventory
    ADD CONSTRAINT inventory_lifecycle_state_check
    CHECK (lifecycle_state IN ('active', 'stored', 'lent_out', 'lost', 'disposed', 'consumed', 'returned', 'archived'));

ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0);

-- How this unit's identity was established, and how much to trust it. 1.0 is
-- reserved for user-entered and barcode-scanned units; anything inferred from a
-- receipt or a photo must write less, because 1.0 reads as ground truth
-- downstream.
ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS identity_confidence REAL NOT NULL DEFAULT 1.0;
ALTER TABLE ci.inventory
    DROP CONSTRAINT IF EXISTS inventory_identity_confidence_check;
ALTER TABLE ci.inventory
    ADD CONSTRAINT inventory_identity_confidence_check
    CHECK (identity_confidence > 0 AND identity_confidence <= 1);

ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS identity_method TEXT;
ALTER TABLE ci.inventory
    DROP CONSTRAINT IF EXISTS inventory_identity_method_check;
ALTER TABLE ci.inventory
    ADD CONSTRAINT inventory_identity_method_check
    CHECK (identity_method IS NULL OR identity_method IN ('user', 'barcode', 'receipt', 'vision', 'import', 'inferred'));

-- Last confirmed sighting, denormalized from ci.object_observations so the
-- things list can sort and filter by it without a per-row subquery.
ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS last_seen_place_entity_id UUID REFERENCES ci.entities(entity_id) ON DELETE SET NULL;

-- Merge tombstone, same contract as ci.entities.merged_into_entity_id
-- (20260803211455) and ci.product_models.merged_into_product_id: non-NULL means
-- this row lost a merge and every read must follow the pointer.
ALTER TABLE ci.inventory
    ADD COLUMN IF NOT EXISTS merged_into_object_id UUID REFERENCES ci.inventory(object_id) ON DELETE SET NULL;

COMMENT ON COLUMN ci.inventory.product_id IS
  'The catalog model this unit is an instance of. NULL means unidentified — the unit is real, the product is not yet known.';
COMMENT ON COLUMN ci.inventory.acquisition_line_item_id IS
  'The receipt line this unit was minted from. Back-pointer to ci.receipt_line_items.minted_object_id.';
COMMENT ON COLUMN ci.inventory.lifecycle_state IS
  'Queryable ownership state. Supersedes disposed_at/disposal_method as the filter; those columns keep the when and the how.';
COMMENT ON COLUMN ci.inventory.identity_confidence IS
  '1.0 = user-entered or barcode-scanned. ~0.7 = receipt-derived. ~0.4 = vision-guessed. 1.0 reads as ground truth to HBPE/RAG — never write it for an inferred unit.';
COMMENT ON COLUMN ci.inventory.merged_into_object_id IS
  'Merge tombstone. Non-NULL means this row lost a merge; follow the pointer. Every read path filters IS NULL.';

CREATE INDEX IF NOT EXISTS inventory_product_idx
    ON ci.inventory (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_receipt_idx
    ON ci.inventory (acquisition_receipt_id) WHERE acquisition_receipt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_line_item_idx
    ON ci.inventory (acquisition_line_item_id) WHERE acquisition_line_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_lifecycle_idx
    ON ci.inventory (user_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS inventory_merged_idx
    ON ci.inventory (merged_into_object_id) WHERE merged_into_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_last_seen_idx
    ON ci.inventory (user_id, last_seen_at DESC) WHERE last_seen_at IS NOT NULL;
-- Keyset pagination for the things list, replacing the load-everything-then-
-- slice Paginator the items query uses today.
CREATE INDEX IF NOT EXISTS inventory_live_keyset_idx
    ON ci.inventory (user_id, created_at DESC, object_id DESC)
    WHERE merged_into_object_id IS NULL;

-- Backfill: the only honest thing SQL can say about lifecycle for existing
-- rows. disposed_at has had no producer, so in practice this updates nothing —
-- but it stops the new column from being born inconsistent with the disposal
-- columns the moment something does start writing them.
UPDATE ci.inventory SET lifecycle_state = 'disposed' WHERE disposed_at IS NOT NULL;

-- Identifier and product backfills are NOT done here. GTIN check digits,
-- ISBN-10 -> 13 conversion, IMEI Luhn and the qualifier computation cannot be
-- kept byte-identical between a SQL expression and normalizeObjectIdentifier.ts,
-- and a divergence is a silent lookup miss. They run as re-runnable maintenance
-- jobs against the real normalizer:
--   POST /api/maintenance/objects/backfill-identifiers
--   POST /api/maintenance/objects/backfill-products
--   POST /api/maintenance/objects/link-graph

-- ci.entity_merges is reused as the merge audit log for these new entity kinds
-- ('ObjectInstance', 'ProductModel') rather than adding a fourth near-identical
-- audit table. It is FK-less by design (20260803211455), so it accepts ids from
-- any table — but the column NAMES then lie, and this comment is the only thing
-- that stops a future reader misreading them.
COMMENT ON COLUMN ci.entity_merges.source_entity_id IS
  'The LOSING row id. Its table depends on entity_type: ci.entities.entity_id for Person/Location, ci.inventory.object_id for ObjectInstance, ci.product_models.product_id for ProductModel. FK-less by design.';
COMMENT ON COLUMN ci.entity_merges.target_entity_id IS
  'The SURVIVING row id. Same per-entity_type table mapping as source_entity_id.';
COMMENT ON COLUMN ci.entity_merges.entity_type IS
  'Which table the id columns refer to: Person | Location | ObjectInstance | ProductModel.';

-- migrate:down
-- Lossy for the new data by definition. The lifecycle_state backfill is not
-- reversible either, but no information is lost: disposed_at was never modified
-- and remains the source it was derived from.
DROP INDEX IF EXISTS ci.inventory_live_keyset_idx;
DROP INDEX IF EXISTS ci.inventory_last_seen_idx;
DROP INDEX IF EXISTS ci.inventory_merged_idx;
DROP INDEX IF EXISTS ci.inventory_lifecycle_idx;
DROP INDEX IF EXISTS ci.inventory_line_item_idx;
DROP INDEX IF EXISTS ci.inventory_receipt_idx;
DROP INDEX IF EXISTS ci.inventory_product_idx;

ALTER TABLE ci.inventory DROP CONSTRAINT IF EXISTS inventory_identity_method_check;
ALTER TABLE ci.inventory DROP CONSTRAINT IF EXISTS inventory_identity_confidence_check;
ALTER TABLE ci.inventory DROP CONSTRAINT IF EXISTS inventory_lifecycle_state_check;

ALTER TABLE ci.inventory DROP COLUMN IF EXISTS merged_into_object_id;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS last_seen_place_entity_id;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS last_seen_at;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS identity_method;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS identity_confidence;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS quantity;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS lifecycle_state;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS acquisition_line_item_id;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS acquisition_receipt_id;
ALTER TABLE ci.inventory DROP COLUMN IF EXISTS product_id;
