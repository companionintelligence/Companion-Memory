-- migrate:up
-- ---------------------------------------------------------------------------
-- ci.receipts: the ordering the explorer's Receipts browse actually pages by.
--
-- `ReceiptService.getEntitiesForReceipts` orders and keyset-pages on
-- COALESCE(purchased_at, created_at) DESC, receipt_id DESC — the purchase date
-- when the extraction found one, and the row's own write time for the undated
-- OCR backlog, which on a fresh import is most of them. Both halves have to
-- live in ONE ordering, because that expression is simultaneously the sort key,
-- the seek predicate and the cursor key the client pages with; splitting them
-- (dated rows here, undated ones there) is what makes a browse dead-end.
--
-- The existing `receipts_user_time_idx (user_id, purchased_at DESC NULLS LAST)`
-- cannot serve it. NULLS LAST parks every undated receipt after the whole dated
-- run, which is a DIFFERENT order from the coalesced one — the planner cannot
-- use it to avoid a sort, and it would not be the order the cursor encodes even
-- if it could. It stays, because ReceiptService.find (the /receipts list, which
-- deliberately shows undated receipts as a tail) is ordered exactly that way.
--
-- receipt_id is in the index so the same-timestamp tiebreak the keyset relies
-- on is resolved by the index rather than a re-sort: a bulk import stamps a
-- whole batch of undated receipts with near-identical created_at values, so
-- that tie is the common case here, not the exotic one.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS receipts_user_browse_idx
    ON ci.receipts (user_id, (COALESCE(purchased_at, created_at)) DESC, receipt_id DESC);

-- migrate:down
DROP INDEX IF EXISTS ci.receipts_user_browse_idx;
