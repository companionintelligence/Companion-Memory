-- migrate:up
-- ---------------------------------------------------------------------------
-- The explorer's plain browse (no search query) now orders, windows and
-- keyset-pages every row-stamped kind by `updated_at` instead of `created_at`:
-- the two are equal until something changes the row, and then the change is
-- the more recent moment. See SearchResolver.getEntityTimestamp and each
-- service's getEntitiesFor* / countEntitiesFor* pair.
--
-- Three of those browses had an index built for the old column. Re-key them so
-- the new ordering is served the same way; the old indexes that another list
-- still walks are left alone.
--
-- * ci.objects — `inventory_live_keyset_idx (user_id, created_at DESC,
--   object_id DESC) WHERE merged_into_object_id IS NULL` still serves
--   ItemService.findPage (the Things page). The browse gets its own.
-- * ci.product_models — `product_models_user_idx (user_id, created_at DESC)`
--   still serves ProductModelService.find. The browse gets its own, with the
--   keyset tiebreak column included and the same live-rows predicate the
--   browse applies.
-- * ci.receipts — `receipts_user_browse_idx` existed ONLY for the browse
--   (see 20260819211924_add_receipts_browse_time_index.sql for why the
--   coalesced expression has to be one ordering), so it is replaced rather
--   than joined by a second copy.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS objects_live_updated_keyset_idx
    ON ci.objects (user_id, updated_at DESC, object_id DESC)
    WHERE merged_into_object_id IS NULL;

CREATE INDEX IF NOT EXISTS product_models_live_updated_keyset_idx
    ON ci.product_models (user_id, updated_at DESC, product_id DESC)
    WHERE merged_into_product_id IS NULL;

CREATE INDEX IF NOT EXISTS receipts_user_browse_updated_idx
    ON ci.receipts (user_id, (COALESCE(purchased_at, updated_at)) DESC, receipt_id DESC);

DROP INDEX IF EXISTS ci.receipts_user_browse_idx;

-- ---------------------------------------------------------------------------
-- `updated_at` is now a sort key, so it has to be present on every row. Three
-- of the browsed tables were created with the column nullable (every insert
-- has always defaulted it to now(), and no writer in the repo names it, so in
-- practice nothing is null — but "in practice" is not an ordering guarantee:
-- a null would sort FIRST under DESC while the resolver dated the row by
-- created_at, and the cursor for that row would not match its position).
-- Backfill from created_at, which is what updated_at equals for an untouched
-- row (ci.files declares created_at nullable too, hence the now() fallback),
-- then pin the constraint. The DEFAULT now() each table already has is
-- left as is.
-- ---------------------------------------------------------------------------
UPDATE ci.files SET updated_at = COALESCE(created_at, now()) WHERE updated_at IS NULL;
ALTER TABLE ci.files ALTER COLUMN updated_at SET NOT NULL;

UPDATE ci.entities SET updated_at = COALESCE(created_at, now()) WHERE updated_at IS NULL;
ALTER TABLE ci.entities ALTER COLUMN updated_at SET NOT NULL;

UPDATE ci.objects SET updated_at = COALESCE(created_at, now()) WHERE updated_at IS NULL;
ALTER TABLE ci.objects ALTER COLUMN updated_at SET NOT NULL;

-- migrate:down
ALTER TABLE ci.objects ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE ci.entities ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE ci.files ALTER COLUMN updated_at DROP NOT NULL;

CREATE INDEX IF NOT EXISTS receipts_user_browse_idx
    ON ci.receipts (user_id, (COALESCE(purchased_at, created_at)) DESC, receipt_id DESC);

DROP INDEX IF EXISTS ci.receipts_user_browse_updated_idx;
DROP INDEX IF EXISTS ci.product_models_live_updated_keyset_idx;
DROP INDEX IF EXISTS ci.objects_live_updated_keyset_idx;
