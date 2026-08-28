-- migrate:up

-- Give every Amazon receipt line back its OWN total, and give the receipt the
-- subtotal that nothing has ever written.
--
-- ## The bug this cleans up after
--
-- `datasources/amazon.ts` wrote each purchase line's `metadata.Total` from the
-- CSV's `Total Amount` / `Total Owed` column, and `push/inputs.ts lineFrom` read
-- that key into `ci.receipt_line_items.total_price_minor`. But that column is
-- what the line was CHARGED — its share of tax and shipping already in it, any
-- promotion already off — not what the line is worth. Order
-- 111-1329443-6205810 is the shape of it: 71.85 of motor oil, 5.57 of tax,
-- 77.42 charged, stored as a LINE total of 77.42 against a unit price of 71.85.
--
-- It hid behind a tautology. A single-line order's line was handed a copy of
-- the order's own total, so "do the lines sum to the header total?" answered
-- yes on 630 of 630 receipts while `quantity × unit_price` matched
-- `total_price_minor` on only 1,723 of 2,147 lines.
--
-- Meanwhile `subtotal_minor`, `tax_minor`, `shipping_minor` and
-- `discount_minor` were NULL on all 630 — the parser emitted no such keys, and
-- `toReceiptInput` had no mapping for two of them even if it had.
--
-- The forward fix (same change as this migration) makes the parser emit
-- `Subtotal`/`Tax`/`Shipping`/`Discount` per line and per order, makes
-- `lineFrom` prefer the line's own `Subtotal`, maps all four onto the header,
-- and checks `subtotal + tax + shipping - discount = total` on every receipt.
-- It repairs nothing already written, which is what this is for.
--
-- ## What this repairs, and what it deliberately does NOT
--
-- REPAIRED — derivable from columns already in the database, with no guessing:
--
--   1. `total_price_minor` = quantity × unit_price_minor. Both operands are
--      stored, both came through unmodified, and their product is the line's
--      pre-tax extended price by definition. 424 of the 2,147 Amazon lines
--      currently disagree (382 carry folded-in tax or shipping, 42 carry a
--      folded-in discount).
--   2. `subtotal_minor` = the sum of those repaired line totals. That IS the
--      definition of a receipt subtotal, and every Amazon receipt has lines.
--
-- NOT REPAIRED — `tax_minor`, `shipping_minor`, `discount_minor`. The numbers
-- are in the CSV (`Unit Price Tax`, `Shipping Charge`, `Total Discounts`) and
-- nowhere in this database: the parser never emitted them, so they are not in
-- `ci.receipts.metadata` either. What IS derivable is the RESIDUAL,
-- `total - subtotal`, which is tax + shipping - discount fused into one number.
-- Writing that residual into `tax_minor` would be inventing a fact — a $6.99
-- shipping charge recorded as sales tax — so it is left NULL and the row says
-- so (see the marker below). Re-importing the Amazon export fills all three,
-- and only that can.
--
-- ## Scope
--
--   * `source_system = 'amazon'` only. The other two sources in this table must
--     not be touched: all 27 Uber lines and the 1 Instagram line have a NULL
--     `unit_price_minor`, so a blanket repair would multiply by NULL and blank
--     the only total they have.
--   * `unit_price_minor IS NOT NULL` for the same reason, restated locally so
--     the guard survives the scope clause being widened later.
--   * `IS DISTINCT FROM` on both writes, so a re-run and an appliance that has
--     already re-imported touch zero rows.
--
-- Dry-run against the QA database (630 receipts / 2,147 lines) before applying:
--   statement 1 updates   424 line items
--   statement 2 updates   630 receipts

UPDATE ci.receipt_line_items li
SET total_price_minor = round(li.unit_price_minor * li.quantity)::bigint,
    updated_at = now()
FROM ci.receipts r
WHERE r.receipt_id = li.receipt_id
  AND r.source_system = 'amazon'
  AND li.unit_price_minor IS NOT NULL
  AND li.total_price_minor IS DISTINCT FROM round(li.unit_price_minor * li.quantity)::bigint;

-- The subtotal, plus a marker naming what is still missing.
--
-- The marker matters because of how the invariant reads a NULL: an unstated tax
-- is a claim that there was none, so a repaired receipt whose subtotal is 71.85
-- against a total of 77.42 would otherwise look like a breakdown that fails to
-- reconcile by 5.57, rather than a breakdown that is honestly incomplete.
WITH line_sums AS (
  SELECT li.receipt_id,
         sum(round(li.unit_price_minor * li.quantity))::bigint AS subtotal_minor
  FROM ci.receipt_line_items li
  JOIN ci.receipts r ON r.receipt_id = li.receipt_id
  WHERE r.source_system = 'amazon'
    AND li.unit_price_minor IS NOT NULL
  GROUP BY li.receipt_id
)
UPDATE ci.receipts r
SET subtotal_minor = line_sums.subtotal_minor,
    metadata = r.metadata || jsonb_build_object(
      'TotalsBreakdownPartial',
      'subtotal recomputed from line items by migration 20260821084433; '
      || 'tax, shipping and discount are not recoverable from stored data — '
      || 'a re-import of the Amazon export fills them'
    ),
    updated_at = now()
FROM line_sums
WHERE r.receipt_id = line_sums.receipt_id
  AND r.source_system = 'amazon'
  AND r.subtotal_minor IS DISTINCT FROM line_sums.subtotal_minor;

-- migrate:down

-- Irreversible by design. Afterwards each repaired line is byte-for-byte what
-- the fixed push writes, and the pre-fix value — the order's tax-inclusive
-- total copied onto its line — is not a number worth restoring. Nothing records
-- which rows were already correct, so a down migration would have to re-derive
-- the wrong value and would corrupt every line a later re-import wrote
-- correctly. Re-importing the export is the forward path for the three
-- components this could not fill.
SELECT 1;
