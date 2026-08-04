-- migrate:up
-- The queryable identity index for physical things.
--
-- Two identifier stores exist today and neither can answer "what do I own with
-- this barcode?":
--   * ci.inventory.identifier_codes — a JSONB bag the importer has written
--     ASINs into since 2025-09. No index, no API, read by nothing.
--   * ci.entity_identifiers — normalized and queryable, but its CHECK is
--     ('email','phone','name'): it is the PEOPLE-linking index and widening it
--     to carry GTINs would put two unrelated resolution domains behind one
--     unique index.
--
-- This is the object-side equivalent of ci.entity_identifiers, deliberately
-- SEPARATE from it. Read the 20260707120000 post-mortem before touching the
-- namespace CHECK below: identifiers are written in ONE multi-row INSERT, so a
-- single CHECK violation aborts the whole batch and a subject carrying a known
-- namespace alongside a new one loses ALL its identifiers — silently, because
-- identifier indexing is non-fatal by design. A new namespace and the code that
-- writes it MUST land in the same PR.
--
-- SUBJECT-POLYMORPHIC by design. A GTIN identifies a product MODEL (every unit
-- of that model shares it); a serial number identifies one owned INSTANCE. Both
-- are identifiers, resolved by one lookup, so they share a table with a
-- subject_type discriminator rather than being split across two near-identical
-- tables. No FK on subject_id — that is the cost of the discriminator, and it
-- matches the FK-less convention the graph tables already use (20260127185821).
--
-- `value_normalized` is written by normalizeObjectIdentifier.ts and NOTHING
-- else. GTIN-14 zero-padding with mod-10 validation, ISBN-10 → ISBN-13
-- conversion, IMEI Luhn and VIN I/O/Q rejection cannot be kept byte-identical
-- between a SQL expression and TypeScript, so the backfill is a maintenance job
-- running the real normalizer, not an UPDATE. Do not "optimize" it into SQL:
-- divergence here is a silent lookup miss, exactly the failure mode the
-- people-linking normalizer comment warns about.
CREATE TABLE IF NOT EXISTS ci.object_identifiers (
    identifier_id    UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    owner_user_id    UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,

    subject_type     TEXT NOT NULL CHECK (subject_type IN ('product_model', 'object_instance')),
    subject_id       UUID NOT NULL,

    namespace        TEXT NOT NULL CHECK (namespace IN (
                         'gtin',    -- UPC-A/EAN-8/EAN-13/ITF-14, all stored as GTIN-14
                         'isbn',    -- ISBN-10 upconverted to ISBN-13
                         'asin',    -- Amazon; all-digit "ASIN"s are ISBNs and route to 'isbn'
                         'mpn',     -- manufacturer part number
                         'sku',     -- retailer stock-keeping unit (NOT globally unique)
                         'serial',  -- unique only within a manufacturer — see `qualifier`
                         'imei',    -- Luhn-validated
                         'vin',     -- 17 chars, I/O/Q rejected
                         'order_id',
                         'rfid',
                         'qr',
                         'custom'
                     )),
    value_normalized TEXT NOT NULL,
    -- Exactly what the source said, for display and for re-normalizing if a
    -- normalizer bug is ever fixed. Never matched against.
    value_raw        TEXT,

    -- Namespace scope. '' for globally-unique namespaces (gtin/isbn/imei/vin).
    -- For 'serial' and 'sku' it is the disambiguator — a Dell service tag '0001'
    -- and an Anker serial '0001' are different objects, and without this in the
    -- claim index below the first writer would silently swallow the second.
    -- Computed by exactly one function (computeQualifier) and STABLE: if a
    -- serial is first claimed under a brand qualifier and later under a
    -- product_id one, the object splits into two identities.
    qualifier        TEXT NOT NULL DEFAULT '',

    confidence       REAL NOT NULL DEFAULT 1.0 CHECK (confidence > 0 AND confidence <= 1),
    -- Provenance of the CLAIM, not of the row: 'user', 'barcode_scan',
    -- 'receipt_ocr', 'vision', 'importer:amazon', 'backfill:identifier_codes'.
    source           TEXT,
    is_primary       BOOLEAN NOT NULL DEFAULT FALSE,
    metadata         JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ci.object_identifiers IS
  'Normalized identifier -> subject index for physical things. Object-side twin of ci.entity_identifiers (people); deliberately a separate table so barcode and contact resolution do not share a unique index.';
COMMENT ON COLUMN ci.object_identifiers.subject_id IS
  'ci.product_models.product_id when subject_type = product_model, ci.inventory.object_id when object_instance. FK-less because it is polymorphic — ObjectMergeService is responsible for repointing on merge.';
COMMENT ON COLUMN ci.object_identifiers.qualifier IS
  'Scope for namespaces that are not globally unique (serial, sku). Empty string for gtin/isbn/imei/vin. Part of the claim uniqueness key.';
COMMENT ON COLUMN ci.object_identifiers.value_normalized IS
  'Written ONLY by normalizeObjectIdentifier.ts. Never reimplement the normalization in SQL — see the table header.';

-- THE CLAIM INDEX: one identifier value, one subject, per user. First writer
-- wins (writes use ON CONFLICT DO NOTHING); a second subject asserting the same
-- value is a duplicate signal, which is what ObjectDuplicateService surfaces for
-- review rather than auto-merging.
--
-- NOTE this index is why ObjectDuplicateService must scan ci.inventory /
-- ci.product_models directly instead of grouping this table: the losing claim
-- was never inserted, so the duplicate is invisible here. Same lesson as
-- PersonDuplicateService.
CREATE UNIQUE INDEX IF NOT EXISTS object_identifiers_claim_uniq
    ON ci.object_identifiers (owner_user_id, namespace, value_normalized, qualifier);

-- Reverse lookup: all identifiers of one subject (detail pages, merge, search
-- index text).
CREATE INDEX IF NOT EXISTS object_identifiers_subject_idx
    ON ci.object_identifiers (subject_type, subject_id);

-- Cross-namespace lookup for scan-anything: a user scanning a barcode does not
-- know whether it is a GTIN or an ISBN.
CREATE INDEX IF NOT EXISTS object_identifiers_value_idx
    ON ci.object_identifiers (owner_user_id, value_normalized);

-- migrate:down
DROP INDEX IF EXISTS ci.object_identifiers_value_idx;
DROP INDEX IF EXISTS ci.object_identifiers_subject_idx;
DROP INDEX IF EXISTS ci.object_identifiers_claim_uniq;
DROP TABLE IF EXISTS ci.object_identifiers;
