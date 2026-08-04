-- migrate:up
-- Purchase evidence as a first-class object, and the line items that are the
-- actual provenance of an owned thing.
--
-- This is the table the retired Rakuten Slice / NeatDesk generation of the
-- product never had: LifeScope's `things` collection was a stub, and its Slice
-- connector never shipped past "development". Today CI-Import-Tools flattens a
-- purchase into ONE ci.inventory row named after the order, so a four-item
-- Amazon order becomes one "thing", the tax and shipping are lost, and there is
-- nowhere to point when asking "where did this come from?".
--
-- A receipt is evidence; a line item is the claim; ci.inventory holds the owned
-- unit minted from that claim. Keeping the three separate is what makes the
-- chain auditable — ci.inventory.acquisition_line_item_id (migration
-- 20260803223025) is the back-pointer.
--
-- MONEY IS INTEGER MINOR UNITS + ISO-4217, never DECIMAL. ci.inventory's
-- existing DECIMAL(10,2) columns are returned by node-postgres as STRINGS with
-- no TypeORM transformer, so ItemEntity.purchasePrice claims `number` and is a
-- string at runtime — arithmetic on it silently concatenates. Nothing new
-- repeats that, and DECIMAL cannot represent JPY (0 minor digits) or KWD (3)
-- honestly anyway.
CREATE TABLE IF NOT EXISTS ci.receipts (
    receipt_id            UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id               UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    owner_user_id         UUID REFERENCES ci.users(id) ON DELETE SET NULL,

    -- Merchant, resolved into the graph when known. merchant_name always holds
    -- the string as printed so an unresolved receipt is still readable.
    merchant_name         TEXT,
    merchant_entity_id    UUID REFERENCES ci.entities(entity_id) ON DELETE SET NULL,
    -- WHERE the purchase happened, as a graph Location. This is the "known place
    -- location" half of object identification: an in-store purchase pins both
    -- the receipt and everything on it to a place, which is the strongest prior
    -- an image-based resolver has (ObjectResolutionService's place_prior step).
    place_entity_id       UUID REFERENCES ci.entities(entity_id) ON DELETE SET NULL,

    purchased_at          TIMESTAMPTZ,
    currency              TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    subtotal_minor        BIGINT,
    tax_minor             BIGINT,
    tip_minor             BIGINT,
    shipping_minor        BIGINT,
    discount_minor        BIGINT,
    total_minor           BIGINT,

    payment_method        TEXT,
    -- Last four digits ONLY. Never store a full PAN here; there is no code path
    -- that writes one and none should be added.
    payment_last4         TEXT CHECK (payment_last4 IS NULL OR payment_last4 ~ '^[0-9]{4}$'),
    order_number          TEXT,
    channel               TEXT CHECK (channel IS NULL OR channel IN ('online', 'in_store', 'app', 'phone', 'unknown')),

    -- The receipt DOCUMENT (PDF/photo/email body) as a ci.content row id, and
    -- the ci.files row it came from. No FKs: content and files are purgeable
    -- (see the /v1/contents/lookup purged-media reconcile path), so a hard FK
    -- would either block a purge or resurrect a dead pointer.
    document_content_id   UUID,
    source_file_id        UUID,
    -- Message id when the receipt arrived by email, for tracing back to the
    -- ci.communications row.
    source_message_id     TEXT,

    -- Extraction lifecycle. 'pending' rows are what
    -- POST /api/maintenance/receipts/extract drains.
    extraction_state      TEXT NOT NULL DEFAULT 'pending'
                            CHECK (extraction_state IN ('pending', 'extracted', 'failed', 'manual', 'not_applicable')),
    extraction_confidence REAL CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
    extraction_model      TEXT,
    extraction_error      TEXT,
    -- OCR/text layer, kept so a re-extraction with a better model does not need
    -- the original binary.
    raw_text              TEXT,

    -- Timeline home, so a receipt shows up in the memory feed like anything else.
    event_id              UUID REFERENCES ci.events(event_id) ON DELETE SET NULL,

    metadata              JSONB NOT NULL DEFAULT '{}',
    source_type           TEXT,
    source_system         TEXT,
    source_id             TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ci.receipts IS
  'Purchase evidence. ci.receipt_line_items holds the per-product claims; ci.inventory.acquisition_line_item_id points back at the line an owned unit was minted from.';
COMMENT ON COLUMN ci.receipts.place_entity_id IS
  'Graph Location where the purchase happened. Feeds the place_prior step of image-based object resolution.';
COMMENT ON COLUMN ci.receipts.total_minor IS
  'Integer minor units of `currency`. NOT decimal — see the table header for why.';
COMMENT ON COLUMN ci.receipts.payment_last4 IS
  'Last four digits only, for user-facing disambiguation. Never a full card number.';

CREATE UNIQUE INDEX IF NOT EXISTS receipts_source_triple_uniq
    ON ci.receipts (owner_user_id, source_type, source_system, source_id)
    WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS receipts_user_time_idx
    ON ci.receipts (user_id, purchased_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS receipts_merchant_idx
    ON ci.receipts (owner_user_id, lower(btrim(merchant_name))) WHERE merchant_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS receipts_merchant_entity_idx
    ON ci.receipts (merchant_entity_id) WHERE merchant_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS receipts_place_idx
    ON ci.receipts (place_entity_id) WHERE place_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS receipts_event_idx
    ON ci.receipts (event_id) WHERE event_id IS NOT NULL;
-- Drain queue for the extraction listener: partial so it stays small as rows
-- move to 'extracted'.
CREATE INDEX IF NOT EXISTS receipts_extraction_pending_idx
    ON ci.receipts (user_id, created_at) WHERE extraction_state = 'pending';

-- =====================================================================
-- Line items
-- =====================================================================
CREATE TABLE IF NOT EXISTS ci.receipt_line_items (
    line_item_id       UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    receipt_id         UUID NOT NULL REFERENCES ci.receipts(receipt_id) ON DELETE CASCADE,
    user_id            UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    owner_user_id      UUID REFERENCES ci.users(id) ON DELETE SET NULL,

    -- Position on the receipt. Part of the idempotency key: re-extracting the
    -- same document must update lines in place, not append a second copy.
    line_number        INTEGER NOT NULL,
    description        TEXT NOT NULL,
    quantity           NUMERIC(12, 3) NOT NULL DEFAULT 1,
    unit_price_minor   BIGINT,
    total_price_minor  BIGINT,
    currency           TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),

    -- Resolved catalog product, when the line could be identified.
    product_id         UUID REFERENCES ci.product_models(product_id) ON DELETE SET NULL,
    brand              TEXT,
    model_number       TEXT,
    category           TEXT,

    -- PHYSICAL vs DIGITAL decides whether this line mints an owned unit. A
    -- Kindle book and a toaster both appear on an Amazon receipt; only one is a
    -- physical thing. Stored per line (not sniffed at read time) so the
    -- classification is auditable and correctable.
    is_physical        BOOLEAN NOT NULL DEFAULT TRUE,
    -- The ci.inventory row minted from this line, if any. NULL means either not
    -- yet minted or deliberately not mintable (is_physical = false).
    minted_object_id   UUID REFERENCES ci.inventory(object_id) ON DELETE SET NULL,

    metadata           JSONB NOT NULL DEFAULT '{}',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ci.receipt_line_items IS
  'One product claim on a receipt. The unit of object minting: a four-item order produces four lines and up to four ci.inventory rows, instead of the single order-named row the importer writes today.';
COMMENT ON COLUMN ci.receipt_line_items.is_physical IS
  'FALSE for digital goods (ebooks, subscriptions, gift cards). Only physical lines mint ci.inventory rows.';
COMMENT ON COLUMN ci.receipt_line_items.minted_object_id IS
  'The owned unit minted from this line. The forward half of the provenance chain; ci.inventory.acquisition_line_item_id is the back-pointer.';

-- Re-extraction idempotency: (receipt, line_number) is the natural key.
CREATE UNIQUE INDEX IF NOT EXISTS receipt_line_items_receipt_line_uniq
    ON ci.receipt_line_items (receipt_id, line_number);

CREATE INDEX IF NOT EXISTS receipt_line_items_receipt_idx
    ON ci.receipt_line_items (receipt_id);
CREATE INDEX IF NOT EXISTS receipt_line_items_product_idx
    ON ci.receipt_line_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS receipt_line_items_minted_idx
    ON ci.receipt_line_items (minted_object_id) WHERE minted_object_id IS NOT NULL;
-- Mint queue: physical lines that have not produced an owned unit yet.
CREATE INDEX IF NOT EXISTS receipt_line_items_unminted_idx
    ON ci.receipt_line_items (user_id, created_at)
    WHERE is_physical AND minted_object_id IS NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.receipt_line_items_unminted_idx;
DROP INDEX IF EXISTS ci.receipt_line_items_minted_idx;
DROP INDEX IF EXISTS ci.receipt_line_items_product_idx;
DROP INDEX IF EXISTS ci.receipt_line_items_receipt_idx;
DROP INDEX IF EXISTS ci.receipt_line_items_receipt_line_uniq;
DROP TABLE IF EXISTS ci.receipt_line_items;

DROP INDEX IF EXISTS ci.receipts_extraction_pending_idx;
DROP INDEX IF EXISTS ci.receipts_event_idx;
DROP INDEX IF EXISTS ci.receipts_place_idx;
DROP INDEX IF EXISTS ci.receipts_merchant_entity_idx;
DROP INDEX IF EXISTS ci.receipts_merchant_idx;
DROP INDEX IF EXISTS ci.receipts_user_time_idx;
DROP INDEX IF EXISTS ci.receipts_source_triple_uniq;
DROP TABLE IF EXISTS ci.receipts;
