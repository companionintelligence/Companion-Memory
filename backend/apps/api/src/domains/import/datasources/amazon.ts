/* Amazon — order history from an Amazon "Your Orders" data export CSV.
   Modern exports ship "Retail.OrderHistory.1.csv" (and "Retail.OrderHistory.*.csv");
   legacy exports used "Order History.csv" / "amazon-order-history.csv". One
   'purchase' item is emitted per row, keyed on the "Order Date" column.

   Digital purchases are further enriched from the files that sit BESIDE the
   order CSVs in a full export (see loadDigitalContext): each line's real
   media mimetype where Amazon states it (Digital.Content.Ownership resource
   types, the Audible marketplace, Appstore entitlements, the music library) —
   with the unclaimed remainder inferred to be video (see digitalMimetype) —
   and a Subscription flag (Digital Orders.csv / the ledger's own Subscription
   Order Type column) that keeps service fees — which are not content at all —
   out of the content table while the per-order commerce.order event still
   marks the purchase. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Item, LineItemRecord, ObjectIdentifierRef } from './timeline';
import { mimeForFile, timeframeContains } from './timeline';

// Filename signature: modern Retail.OrderHistory.* or legacy "Order History".
const FILENAME_RE = /Retail\.OrderHistory|Order.?History/i;

function filenameMatches(name: string): boolean {
  return path.extname(name).toLowerCase() === '.csv' && FILENAME_RE.test(name);
}

// Header sniff: an Amazon order export carries both an order id and product name
// column. Match the modern "Order ID"/"Product Name" pair specifically so we do
// not false-match other importers' CSV fixtures.
function headerMatches(text: string): boolean {
  let header = text;
  if (header.charCodeAt(0) === 0xfeff) {
    header = header.slice(1);
  }

  const nl = header.indexOf('\n');
  if (nl !== -1) {
    header = header.slice(0, nl);
  }

  return /order\s*id/i.test(header) && /product\s*name/i.test(header);
}

/**
 * Read the first column present out of a list of aliases.
 *
 * Amazon renames columns between export vintages, and the rename is silent —
 * the "Your Orders" download calls quantity `Original Quantity` and the amount
 * `Total Amount`, where the "All Data Categories" download calls the same two
 * fields `Quantity` and `Total Owed`. Reading only one spelling does not throw;
 * it yields undefined for every row, which quietly emptied `metadata.Quantity`
 * and disabled the unfulfilled-line guard on the whole export.
 */
function col(row: Record<string, string>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== '') {
      return v;
    }
  }

  return undefined;
}

/*
 * Column dialects. Amazon ships THREE header spellings for the same fields:
 * spaced Title Case ("Order Date" — Retail.OrderHistory, Your Orders), spaced
 * with renames ("Original Quantity"/"Total Amount"), and run-together
 * CamelCase ("OrderDate", "ProductName", "OurPrice" — the Digital-Ordering.1
 * family, e.g. "Digital Items.csv"). Every read goes through these lists so a
 * new vintage is one entry, not a hunt through the file. Order matters: the
 * canonical spaced name first, so files carrying both never regress.
 *
 * CamelCase has no total-paid column at all — `OurPrice` is the pre-tax price
 * (taxes/promos live in the separate "Digital Orders Monetary.csv" ledger,
 * which this importer does not join), so those rows carry a Unit Price but no
 * Total by design.
 *
 * The Audible dialect ("Your Audible Account & Membership/Purchase History.csv")
 * dates on `Order Place Date`, counts on `Units`, and prices on `Net Price` —
 * the cash actually paid, 0.00 when a membership credit covered it, which is
 * the honest price of a credit purchase. Its OTHER price columns are
 * deliberately not read: `Regular Price` is the list price, and
 * `Price Paid Member` is internal bookkeeping (it varies between 0.00 and a
 * member rate across otherwise-identical credit purchases).
 */
const DATE_COLS = ['Order Date', 'OrderDate', 'Order Place Date'];
const ORDER_ID_COLS = ['Order ID', 'OrderId'];
const PRODUCT_COLS = ['Product Name', 'ProductName'];
const QUANTITY_COLS = [
  'Quantity',
  'Original Quantity',
  'OriginalQuantity',
  'Quantity Ordered',
  'QuantityOrdered',
  'Units',
];
const TOTAL_COLS = ['Total Owed', 'Total Amount', 'Total Charged', 'Net Price'];
const UNIT_PRICE_COLS = ['Unit Price', 'OurPrice', 'Net Price'];
const CURRENCY_COLS = ['Currency', 'OurPriceCurrencyCode', 'Base Currency Code', 'BaseCurrencyCode'];

/*
 * The money BREAKDOWN columns — everything the total is made of. Both retail
 * dialects carry all three of these ("Your Orders" and Retail.OrderHistory
 * differ only in the name of the total itself); the digital/Audible dialects
 * carry none of them, so a line from those states a total and no breakdown,
 * which is the honest answer rather than a fabricated one.
 *
 * `Unit Price Tax` is PER UNIT, like `Unit Price` beside it — the line's tax is
 * quantity × this, which is what makes the reconciliation below come out.
 *
 * DELIBERATELY ABSENT: `Shipment Item Subtotal` and `Shipment Item Subtotal
 * Tax`. They read like the line's own subtotal and tax, and they are not —
 * they are the SHIPMENT's, repeated verbatim on every line in that shipment.
 * Order 111-4820738-6806659 in a real export is three lines of 22.89, 39.99 and
 * 23.89, and all three carry `Shipment Item Subtotal` = 86.77 — their SUM.
 * Using that column as a line subtotal triples a three-line shipment. It is
 * also "Not Available" on 42 rows of that same export. Quantity × Unit Price is
 * the line's own extended price, is always stated, and is what the export's own
 * arithmetic checks out against (see the reconciliation note on lineMoney).
 */
const UNIT_TAX_COLS = ['Unit Price Tax', 'UnitPriceTax'];
const SHIPPING_COLS = ['Shipping Charge', 'ShippingCharge'];
const DISCOUNT_COLS = ['Total Discounts', 'TotalDiscounts'];

/**
 * Values Amazon puts in the ASIN column that are NOT identifiers. Grocery and
 * Amazon Fresh line items carry the literal sentinel `_ASINLESS_` (every such
 * row in an order shares it), and other vintages leave the column blank or fill
 * it with Amazon's ubiquitous "Not Available" filler. Treating any of these as
 * an id makes distinct products collide.
 */
const ASIN_SENTINELS = new Set(['', '_asinless_', 'not available', 'n/a', 'na']);

/**
 * The object identifier an Amazon line states, in the shape
 * `CanonicalRecord.identifiers` is built from.
 *
 * Amazon reuses ONE column for two namespaces: an ASIN for everything, and a
 * book's ISBN-10 (the export header even says `ASIN/ISBN`). The shape decides —
 * 9 digits plus a digit-or-X check character is an ISBN-10 — and the shared
 * normalizer then upconverts it to ISBN-13, so the book bought here and the
 * same book scanned off its barcode land on ONE identity. Getting this wrong is
 * not cosmetic: it splits a book into two objects forever.
 *
 * An all-digit ASIN needs no help — `normalizeObjectIdentifier` re-routes it —
 * but an ISBN-10 ending in 'X' passes the ASIN grammar and would stick in the
 * wrong namespace, which is what this shape check is for.
 */
function identifiersFor(asin: string): ObjectIdentifierRef[] | undefined {
  if (!asin) {
    return undefined;
  }

  const namespace = /^[0-9]{9}[0-9X]$/i.test(asin.trim()) ? 'isbn' : 'asin';

  return [{ namespace, value: asin }];
}

/** The primitive part of a metadata value (a receipt line holds no arrays). */
function primitive(v: unknown): string | number | boolean | null | undefined {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null
    ? (v as string | number | boolean | null | undefined)
    : undefined;
}

/** The ASIN when the column holds a real one, else '' (see ASIN_SENTINELS). */
function realAsin(raw: string): string {
  const trimmed = raw.trim();

  return ASIN_SENTINELS.has(trimmed.toLowerCase()) ? '' : trimmed;
}

/**
 * Identity fallback for a row whose ASIN is a sentinel: a short hash of the
 * product name. Normalised (case-folded, whitespace-collapsed) first, because
 * unlike an ASIN a product name is display text that Amazon re-words between
 * export vintages — folding the cosmetic differences keeps the id stable across
 * as many re-exports as we can manage. Returns '' when there is no name either.
 */
function productIdent(product: string): string {
  const norm = product.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!norm) {
    return '';
  }

  return `p:${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12)}`;
}

/**
 * Stable per-row identity: `amazon:<order id>:<asin | product-name hash>`.
 *
 * Deliberately carries NO file position. The CSV is sorted newest-order-first,
 * so a row index shifts for the whole history every time a new order is placed
 * — keying on it gave every row a fresh id on each export and re-imported the
 * entire order history as duplicates (the push dedups on this id).
 *
 * Rows that legitimately share the resulting key are the SAME purchase and
 * collapse on the `items` primary key / (data_source, content_hash) index:
 * Amazon emits byte-identical duplicate rows, splits one line item across two
 * shipment rows (different carrier + ship date), and pairs a fulfilled row with
 * a zero-quantity unfulfilled one. Distinct grocery items in one order do NOT
 * collapse — that is what the product-name fallback is for.
 */
function rowIdentity(row: Record<string, string>, orderId: string, base: string): string {
  const asin = realAsin(row['ASIN'] || row['ASIN/ISBN'] || row['ISBN'] || '');
  let ident = asin || productIdent(col(row, ...PRODUCT_COLS) || '');
  if (!ident) {
    // No identifier and no name. Nothing describes this row but its own
    // contents, so hash those — still position-free, unlike a row index.
    const shape = Object.keys(row)
      .sort()
      .map((k) => `${k}=${row[k] ?? ''}`)
      .join('\0');
    ident = `r:${crypto.createHash('sha1').update(shape).digest('hex').slice(0, 12)}`;
  }

  return `amazon:${orderId || base}:${ident}`;
}

/**
 * Why this row is not a purchase, or null when it is one.
 *
 * Importing a non-purchase is actively wrong rather than merely noisy:
 * `Unit Price` survives on these rows and is what the things mapping reads
 * for `purchasePrice`, so each one lands in stock at full price having never
 * been bought.
 *
 * Two independent signals, because neither covers the other:
 *
 * - `Order Status` is Amazon's own verdict and is authoritative. A cancelled
 *   order can still carry a non-zero `Total Owed` (the amount that WOULD have
 *   been charged), so an amount-based test alone lets it through.
 * - A zero quantity AND a zero amount owed catches the unfulfilled line inside
 *   an order whose status is `Closed` — Amazon pairs the fulfilled row with a
 *   zeroed one, or leaves a lone never-shipped line behind. Both fields must
 *   parse as a real 0: a blank or "Not Available" cell is not a zero, and a
 *   zero-quantity row that still owes money under a non-cancelled status is
 *   left alone for a human to interpret.
 */
function dropReason(row: Record<string, string>): string | null {
  if (/cancel/i.test(row['Order Status'] ?? '')) {
    return 'cancelled_order';
  }

  const num = (raw: string | undefined): number => {
    if (raw === undefined) {
      return NaN;
    }

    const trimmed = raw.trim();

    return trimmed === '' ? NaN : Number(trimmed);
  };

  if (num(col(row, ...QUANTITY_COLS)) === 0 && num(col(row, ...TOTAL_COLS)) === 0) {
    return 'unfulfilled_line';
  }

  return null;
}

/** The row's Order Date as a Date, or undefined when absent/unparseable. */
function rowTimestamp(row: Record<string, string>): Date | undefined {
  const raw = col(row, ...DATE_COLS);
  if (!raw) {
    return undefined;
  }

  const d = new Date(raw);

  return isNaN(d.getTime()) ? undefined : d;
}

/** Discard rows that are byte-for-byte repeats of one already seen. */
function dedupeIdenticalRows(rows: Record<string, string>[]): Record<string, string>[] {
  const seen = new Set<string>();
  const out: Record<string, string>[] = [];
  for (const row of rows) {
    const shape = JSON.stringify(
      Object.keys(row)
        .sort()
        .map((k) => [k, row[k] ?? '']),
    );
    if (seen.has(shape)) {
      continue;
    }

    seen.add(shape);
    out.push(row);
  }

  return out;
}

/**
 * One money/quantity cell as a number, or undefined when the cell states none.
 *
 * `Number()` is NOT good enough here, and both of the ways Amazon's own CSV
 * writer defeats it are live in a real export (counted over the 2,064 rows of
 * one "Your Orders" download):
 *
 *   - THOUSANDS SEPARATORS inside the quoted cell — `"10,615.11"`, `"2,398"`.
 *     13 `Unit Price` cells and 11 `Total Amount` cells. `Number('10,615.11')`
 *     is NaN, so `sumOf` dropped those rows out of a merged line, and
 *     `pushOrders` (which tested `Number.isFinite`) dropped their order totals
 *     entirely: eleven orders — about $34k of the history — reached
 *     `ci.events.metadata` with no `Amount` at all and vanished from the spend
 *     chart, even though the receipt behind them had a total.
 *   - EXCEL TEXT-PROTECTION QUOTING on `Total Discounts` — the literal
 *     characters `'-89'`, apostrophes included, on every one of the 50 rows
 *     that carries a discount. Also NaN, which is why no discount has ever
 *     reached the breakdown.
 *
 * The cleaning rule is deliberately the SAME one `push/canonical.ts num()`
 * applies on the far side of the push (strip everything but digits, sign and
 * the decimal point), so the parser's arithmetic and its reader's cannot
 * disagree about what a cell says. "Not Available" and blanks clean to nothing
 * and answer undefined — a missing cell is not a zero.
 */
function amount(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const cleaned = raw.replace(/[^0-9.+-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '+' || cleaned === '.') {
    return undefined;
  }

  const n = Number(cleaned);

  return Number.isFinite(n) ? n : undefined;
}

/** Sum the parseable values, ignoring "Not Available"/blank cells. */
function sumOf(values: (string | undefined)[]): number | undefined {
  const nums = values.map(amount).filter((n): n is number => n !== undefined);
  if (!nums.length) {
    return undefined;
  }

  return nums.reduce((a, b) => a + b, 0);
}

/** Money as a metadata string: 2dp for fractional amounts, bare for whole ones. */
function money(n: number | undefined): string | undefined {
  if (n === undefined) {
    return undefined;
  }

  const rounded = Math.round(n * 100) / 100;

  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/** An already-emitted metadata value as a number — money is written as a string, quantity as a number. */
function numeric(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }

  return typeof v === 'string' ? amount(v) : undefined;
}

/** The components an order's total is made of, as canonical metadata keys. */
const BREAKDOWN_FIELDS = ['Subtotal', 'Tax', 'Shipping', 'Discount'] as const;
type BreakdownField = (typeof BREAKDOWN_FIELDS)[number];
type Breakdown = Record<BreakdownField, number | undefined>;

/** A breakdown that states nothing yet — every component absent, none zeroed. */
function emptyBreakdown(): Breakdown {
  return { Subtotal: undefined, Tax: undefined, Shipping: undefined, Discount: undefined };
}

/**
 * The RECONCILIATION INVARIANT: subtotal + tax + shipping − discount == total.
 *
 * Returns a human statement of the disagreement, or undefined when the order
 * adds up (or states too little to check — a dialect with no breakdown at all,
 * or an order whose total never parsed, is not a violation, it is a silence).
 *
 * WHY THIS EXISTS. A breakdown is four numbers that are only meaningful
 * together, and every one of them is a column this parser CHOSE to read. Get
 * one wrong — read the shipment's subtotal as the line's, miss a discount
 * because it arrived as `'-89'` — and the row still looks perfectly plausible:
 * four amounts and a total, no nulls, nothing to notice. The identity is the
 * only thing that can tell. It held on 492 of 495 orders of a real export the
 * moment the columns were read correctly, and all 3 that fail are charges the
 * CSV genuinely does not itemise anywhere: +$7.00 and +$6.00 on a 49" and a 50"
 * television (a state e-waste recycling fee) and +$0.60 on a 12-pack of beer
 * (a 5¢-per-container deposit). Exactly the class of thing a breakdown should
 * flag rather than absorb.
 *
 * The numbers are still WRITTEN when they disagree: they are Amazon's own, and
 * discarding them loses more than it protects. What must not happen is writing
 * them SILENTLY, so the mismatch is both logged and stamped on the receipt.
 *
 * TOLERANCE. One hundredth of a unit, because the components are independently
 * rounded before they are stored (a per-unit tax × a quantity of 3 rounds where
 * Amazon's own per-line figure did not), and a cent of rounding is not a
 * disagreement about what was charged.
 */
function reconcileOrder(breakdown: Breakdown, total: number | undefined): string | undefined {
  // Nothing to check against, or nothing to check: a line with no breakdown at
  // all (Audible, the digital ledger) states no claim that could be wrong.
  if (total === undefined || breakdown.Subtotal === undefined) {
    return undefined;
  }

  const cents = (n: number | undefined): number => Math.round((n ?? 0) * 100);
  const expected =
    cents(breakdown.Subtotal) + cents(breakdown.Tax) + cents(breakdown.Shipping) - cents(breakdown.Discount);
  const charged = cents(total);
  const delta = expected - charged;
  if (Math.abs(delta) <= 1) {
    return undefined;
  }

  const parts = BREAKDOWN_FIELDS.map((f) => `${f.toLowerCase()} ${money(breakdown[f] ?? 0)}`).join(', ');

  return `${parts} → ${money(expected / 100)}, but ${money(total)} was charged (off by ${money(delta / 100)})`;
}

/**
 * The id of the per-order aggregate an order id rolls up into.
 *
 * ONE definition, used by both ends of the rollup: the aggregate's own item id
 * and the `ReceiptRollupId` each line carries. They are two halves of one
 * pointer, and a rollup marker that does not spell the aggregate's id exactly
 * routes the line's receipt nowhere (push/canonical.ts `isRolledUp`).
 */
function orderRollupId(orderId: string): string {
  return `amazon:order:${orderId}`;
}

/**
 * The money a line is MADE OF, as metadata strings — or an empty bag when the
 * dialect states no breakdown at all (digital, Audible, the CamelCase family).
 *
 * ── WHAT THE COLUMNS ACTUALLY MEAN ────────────────────────────────────────
 *
 * Read straight off a real 2,064-row "Your Orders" export, not assumed:
 *
 *   Subtotal  Quantity × `Unit Price`      the line's own pre-tax extended price
 *   Tax       Quantity × `Unit Price Tax`  per-unit tax, so it scales with qty
 *   Shipping  `Shipping Charge`            per LINE, not repeated per shipment
 *   Discount  −`Total Discounts`           Amazon states it NEGATIVE (see below)
 *
 * and the row's own `Total Amount`/`Total Owed` is what was CHARGED for the
 * line — subtotal + tax + shipping − discount, tax included. That identity is
 * not a guess: it holds to the cent on 1,995 of the 2,000 priced rows of that
 * export, and per order on 492 of 495. `Total` therefore keeps its existing
 * meaning here (the order aggregate sums it, and the spend chart reads that
 * sum); the four components are what was missing, and `Subtotal` is the number
 * `ci.receipt_line_items.total_price_minor` has always wanted — the LINE's own
 * total, which is not the same number as what the line was charged.
 *
 * DISCOUNT SIGN. Amazon writes a discount as a negative, Excel-quoted string —
 * the literal characters `'-89'` — so it is negated here into the POSITIVE
 * magnitude the receipt breakdown subtracts (`subtotal + tax + shipping −
 * discount = total`). Left signed it would be refused outright downstream:
 * `toCostMinorUnits` writes no negative into a cost column.
 *
 * Every read goes through {@link amount}, which is what makes `'-89'` and
 * `"10,615.11"` numbers rather than NaN.
 */
function lineMoney(rows: Record<string, string>[]): Record<string, string | undefined> {
  let subtotal: number | undefined;
  let tax: number | undefined;

  for (const row of rows) {
    const qty = amount(col(row, ...QUANTITY_COLS));
    const unit = amount(col(row, ...UNIT_PRICE_COLS));
    const unitTax = amount(col(row, ...UNIT_TAX_COLS));

    // Summed PER ROW rather than as (merged quantity × the primary row's unit
    // price): a line split across shipments can be split across prices too, and
    // the shipments are disjoint, so their extended prices add.
    if (qty !== undefined && unit !== undefined) {
      subtotal = (subtotal ?? 0) + qty * unit;
    }

    if (qty !== undefined && unitTax !== undefined) {
      tax = (tax ?? 0) + qty * unitTax;
    }
  }

  const shipping = sumOf(rows.map((r) => col(r, ...SHIPPING_COLS)));
  const discounts = sumOf(rows.map((r) => col(r, ...DISCOUNT_COLS)));

  return {
    Subtotal: money(subtotal),
    Tax: money(tax),
    Shipping: money(shipping),
    Discount: discounts === undefined ? undefined : money(Math.abs(discounts)),
  };
}

/**
 * Merge the rows of ONE order line from an order-history CSV.
 *
 * Amazon splits a multi-unit line across one row per SHIPMENT — the same order
 * id and ASIN, each row carrying that shipment's own quantity, amount and
 * shipping charge, so the parts are genuinely disjoint. Keeping only one row
 * understated the holding: a line of 5 units shipped 2-then-3 was recorded
 * as 2.
 *
 * A single-row line keeps its raw strings untouched; only a real merge
 * recomputes, and it records `Shipments` so the merge is visible rather than
 * silent. The money BREAKDOWN ({@link lineMoney}) is always computed, on one
 * row or five — it is arithmetic over columns, not a passthrough of one.
 */
function mergeLine(rows: Record<string, string>[]): Record<string, string | number | undefined> {
  const primary = rows[0];
  const currency = col(primary, ...CURRENCY_COLS);
  const unitPrice = col(primary, ...UNIT_PRICE_COLS);
  const breakdown = lineMoney(rows);
  if (rows.length === 1) {
    return {
      Quantity: amount(col(primary, ...QUANTITY_COLS)),
      Total: col(primary, ...TOTAL_COLS),
      Currency: currency,
      'Unit Price': unitPrice,
      ...breakdown,
    };
  }

  const quantity = sumOf(rows.map((r) => col(r, ...QUANTITY_COLS)));
  const total = sumOf(rows.map((r) => col(r, ...TOTAL_COLS)));

  return {
    Quantity: quantity,
    Total: money(total),
    Currency: currency,
    'Unit Price': mergedUnitPrice(rows, unitPrice, quantity, total),
    Shipments: rows.length,
    ...breakdown,
  };
}

/**
 * A merged line's own Unit Price — `primary`'s, UNLESS these rows disagree
 * on it, in which case that single value would misstate every one of them.
 *
 * The docstring above `mergeLine` describes the common case this exists for —
 * one ASIN split across shipment rows, each carrying an identical per-unit
 * price. A weight-priced grocery item breaks that assumption while still
 * sharing one ASIN: real export order 113-4686340-8106606 carries TWO
 * "PRODUCE Organic Shallots" rows, same ASIN (B000RH1NGG), priced 0.55 and
 * 0.25 — two physically different units Amazon weighed and charged
 * separately, not one item priced twice. `rowIdentity` groups both under
 * that one ASIN, so without this check they collapse to quantity 2 at
 * whichever row's price happened to sort first — silently dropping the
 * other row's real cost from the line's own math.
 *
 * When prices genuinely agree (the common case — actual multi-shipment
 * splits of one identical line), this returns exactly what primary already
 * carried, unchanged. Only on a real disagreement does it fall back to
 * Total ÷ Quantity — the honest AVERAGE per unit, which is what makes
 * `quantity * unitPrice = total` hold for the line as reported, at the cost
 * of no longer stating any one row's real per-unit price exactly.
 */
function mergedUnitPrice(
  rows: Record<string, string>[],
  primaryUnitPrice: string | undefined,
  quantity: number | undefined,
  total: number | undefined,
): string | undefined {
  const perRow = rows.map((r) => amount(col(r, ...UNIT_PRICE_COLS)));
  const agree = perRow.every((n) => n !== undefined && n === perRow[0]);
  if (agree || quantity === undefined || quantity === 0 || total === undefined) {
    return primaryUnitPrice;
  }

  return money(total / quantity);
}

/**
 * Is everything in this file digital by definition?
 *
 * Amazon files its digital purchases into their own files and says so in the
 * name — "Digital Content Orders.csv", "Digital Items.csv",
 * "Retail.DigitalSoftwareAndVideogames.Entitlements.1.csv". Nothing in those
 * rows is a physical object, so they belong in CI-Server's `content` table,
 * not `things`. The mapping otherwise guesses from the product name
 * (mapping.ts `isDigitalGood`), which cannot know that "Prime Membership Fee"
 * is not a thing on a shelf — 143 of these landed in the physical-things plane. The
 * filename is the reliable signal, so items from such a file carry an explicit
 * `metadata.Digital` that overrides the guess.
 *
 * Matched as a bare substring rather than a whole word on purpose: Amazon runs
 * the words together ("DigitalSoftwareAndVideogames"), which a `\b`-anchored
 * pattern would miss.
 */
function isDigitalContentFile(base: string): boolean {
  return /digital/i.test(base);
}

/**
 * Is this the Audible purchase-history dialect?
 *
 * Audible's file is just "Purchase History.csv" — the name says nothing — but
 * its columns are unmistakable: no other Amazon order export carries
 * `Consumed Credit` alongside `Net Price`. An audiobook is digital content by
 * definition, so rows from this file take the same `metadata.Digital` routing
 * as the Digital-named files.
 */
function isAudiblePurchaseFile(rows: Record<string, string>[]): boolean {
  const first = rows[0];

  return !!first && 'Consumed Credit' in first && 'Net Price' in first;
}

/**
 * CREDIT or CASH for an Audible purchase — the context a 0.00 Net Price needs
 * (a credit-covered audiobook is not a free one). `Type` states it outright;
 * a vintage without `Type` still carries `Consumed Credit`, and a consumed
 * credit is the same fact.
 */
function audiblePayment(row: Record<string, string>): string | undefined {
  const t = (row['Type'] || '').trim().toUpperCase();
  if (t === 'CREDIT' || t === 'CASH') {
    return t;
  }

  const credit = Number(row['Consumed Credit']);
  if (Number.isFinite(credit)) {
    return credit > 0 ? 'CREDIT' : 'CASH';
  }

  return undefined;
}

/**
 * Does this CSV hold MONETARY COMPONENTS rather than order lines?
 *
 * "Digital Content Orders.csv" is a ledger: each row is one component of a
 * digital purchase — the price, its tax, a promotion, a coupon — carrying a
 * signed `Transaction Amount`, so one purchase spans several rows. It sniffs
 * as order history (it has an Order ID and a Product Name), and treating its
 * rows as line items produced one priceless item per component.
 */
function isComponentLedger(rows: Record<string, string>[]): boolean {
  const first = rows[0];

  return !!first && 'Component Type' in first && 'Transaction Amount' in first;
}

/**
 * Collapse a component ledger's rows into the one purchase they describe.
 *
 * `Transaction Amount` is signed and the components are disjoint, so their sum
 * is what was actually paid including tax and net of any promotion or coupon
 * (Prime: 139.00 price + 10.77 tax = 149.77). `Price` and `List Price Amount`
 * are line-level and repeat on every row, so they are read once — keeping both
 * is what records that a $1.99 game was taken for $0.00 on a promotion.
 *
 * `Component Type` names what each row's `Transaction Amount` actually is — in
 * the two shapes this corpus contains, 'Price Amount' and 'Tax' — so the
 * breakdown a receipt needs (Subtotal/Tax) can be read directly off the
 * ledger rather than inferred. Only these two known types are mapped; a type
 * this file has never seen is left OUT of Subtotal/Tax on purpose — folding
 * an unrecognized component into either would misreport what it was, and the
 * reconciliation check downstream (subtotal+tax+shipping-discount=total)
 * surfaces the gap instead of silently absorbing it. 'Subtotal' and 'Tax' are
 * the literal canonical keys `push/commerceKeys.ts` resolves receipts from —
 * datasources do not import push/, so they are spelled out here the same way
 * this function already spells out 'Total' and 'Unit Price'.
 */
function ledgerFields(rows: Record<string, string>[]): Record<string, string | number | undefined> {
  const primary = rows[0];
  const paid = sumOf(rows.map((r) => r['Transaction Amount']));
  const price = sumOf([primary['Price']]);
  const list = sumOf([primary['List Price Amount']]);
  const qty = sumOf([col(primary, ...QUANTITY_COLS)]);
  const priceComponent = sumOf(
    rows.filter((r) => r['Component Type'] === 'Price Amount').map((r) => r['Transaction Amount']),
  );
  const taxComponent = sumOf(
    rows.filter((r) => r['Component Type'] === 'Tax').map((r) => r['Transaction Amount']),
  );

  return {
    Quantity: qty,
    Total: money(paid),
    Currency:
      primary['Base Currency Code'] || primary['Price Currency Code'] || primary['Currency'] || undefined,
    'Unit Price': money(price),
    // Only interesting when it differs from what was charged.
    'List Price': list !== undefined && price !== undefined && list !== price ? money(list) : undefined,
    Components: rows.length,
    Subtotal: money(priceComponent),
    Tax: money(taxComponent),
  };
}

async function sniffHeader(fpath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(fpath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead: n } = await handle.read(buf, 0, 4096, 0);

    return headerMatches(buf.toString('utf8', 0, n));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Digital.Content.Ownership resourceType → the item's media mimetype. The
 * ownership records are Amazon's own per-ASIN taxonomy of what a digital
 * thing IS, so these are stated facts, not guesses. Anything bought from
 * Amazon in these classes is definitionally in Amazon's format: Kindle books
 * (incl. samples and sideloaded personal docs) are Kindle-format ebooks,
 * music is mp3, Appstore apps are Android packages.
 */
const RESOURCE_TYPE_MIME: Record<string, string> = {
  KindleEBook: 'application/vnd.amazon.ebook',
  KindleEBookSample: 'application/vnd.amazon.ebook',
  KindlePDoc: 'application/vnd.amazon.ebook',
  DigitalMusicTrack: 'audio/mpeg',
  DigitalMusic: 'audio/mpeg',
  MobileApp: 'application/vnd.android.package-archive',
};

/** Title normalization for the Prime Video match: quotes/case/space-insensitive. */
function normTitle(raw: string): string {
  return raw
    .replace(/^"+|"+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The row's product name, with Amazon's redaction fillers read as no name. */
function realProductName(row: Record<string, string>): string {
  const raw = (col(row, ...PRODUCT_COLS) ?? '').trim();

  return /^not (applicable|available)$/i.test(raw) ? '' : raw;
}

/**
 * A digital line whose name says it is NOT a video: boxed-software downloads
 * ("TurboTax … Tax Software"), console/game codes ("… - PS4 [Digital Code]",
 * "[Online Game Code]"), gift cards, and service fees ("Prime Membership
 * Fee", "Kindle Unlimited" — the belt-and-braces backstop for when the
 * subscription join has no Digital Orders.csv in reach). These are the known
 * exceptions to the video-by-elimination fallback below — they resolve
 * through none of the sidecar signals but are certainly not videos.
 */
const NON_VIDEO_NAME_RE =
  /software|game code|digital code|gift card|membership|subscription|kindle unlimited/i;

/**
 * What the rest of the archive knows about digital purchases. Loaded once per
 * import from the files beside the order CSVs (same sibling-walk pattern
 * kindle_reading uses for titles); every map is best-effort — a bare-file
 * drop or an orders-only export just yields empty maps and the purchase
 * imports exactly as before.
 */
interface DigitalContext {
  /** ASIN → resourceType from the Digital.Content.Ownership JSON records. */
  ownership: Map<string, string>;
  /** ASINs of Appstore app entitlements (Appstore.Entitlements PDI.csv). */
  appAsins: Set<string>;
  /** Track/album ASIN → audio mimetype from the Your Music Library CSVs. */
  musicAsins: Map<string, string>;
  /** Order ids Digital Orders.csv marks Subscription_Signup/_Renewal. */
  subscriptionOrders: Set<string>;
}

const EMPTY_DIGITAL_CONTEXT: DigitalContext = {
  ownership: new Map(),
  appAsins: new Set(),
  musicAsins: new Map(),
  subscriptionOrders: new Set(),
};

export class AmazonFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      const base = path.basename(root);

      // Filename alone used to be enough for the top confidence tier — but
      // "Order History.csv" is boilerplate phrasing several other retailers'
      // own "download your data" exports use verbatim (eBay, Target,
      // Walmart-style tools), with completely different columns. Require the
      // same header verification the unnamed fallback below already does, so
      // a same-named CSV from elsewhere is never claimed on filename alone.
      if (filenameMatches(base)) {
        return (await sniffHeader(root)) ? { confidence: 0.95 } : { confidence: 0 };
      }

      if (path.extname(base).toLowerCase() === '.csv' && (await sniffHeader(root))) {
        return { confidence: 0.85 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      const found = await this.findFiles(root);
      if (found.length) {
        return { confidence: 0.95 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  // Locate Amazon order CSVs in a directory, recursing through the nested
  // folders Amazon's archives use — "Your Orders" keeps CSVs one level down,
  // but a full "All Data Categories" export (plus a drag-and-drop staging
  // wrapper) buries Digital-Ordering.1 three or four levels deep.
  private async findFiles(dir: string, depth = 0): Promise<string[]> {
    const out: string[] = [];
    let names: fs.Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }

    for (const dirent of names) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (depth < 4) {
          out.push(...(await this.findFiles(full, depth + 1)));
        }
      } else if (dirent.isFile()) {
        if (filenameMatches(dirent.name)) {
          out.push(full);
        } else if (path.extname(dirent.name).toLowerCase() === '.csv' && (await sniffHeader(full))) {
          out.push(full);
        }
      }
    }

    return out;
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    let files: string[] = [];
    if (stat.isFile()) {
      files = [root];
    } else if (stat.isDirectory()) {
      // Sorted: the order aggregate's line numbers follow the order the lines
      // are parsed in, and readdir order is filesystem-dependent. Sorting makes
      // the numbering reproducible across machines and re-imports, which
      // matters because `(receipt_id, line_number)` is a natural key.
      files = (await this.findFiles(root)).sort();
    }

    // The digital sidecars (ownership records, entitlements, viewing history)
    // are only worth walking for when a digital file actually imports, so the
    // load is lazy and memoized. A bare-file drop still reads its siblings.
    let digitalCtx: DigitalContext | undefined;
    const searchRoot = stat.isDirectory() ? root : path.dirname(root);
    const getDigitalCtx = () => (digitalCtx ??= this.loadDigitalContext(searchRoot, params));

    // The per-order aggregate spans EVERY file in this export, not each file on
    // its own. An order id legitimately appears in two matched CSVs (Retail and
    // Digital, or a split "Your Orders" export), and a per-file rollup emitted
    // two receipts for it — each renumbering its lines from 1, so the
    // (receipt_id, line_number) natural key collided across the halves. The
    // lines are collected here and rolled up once, after the last file.
    const orderLines: Item[] = [];

    for (const fpath of files) {
      await this.processFile(fpath, getDigitalCtx, params, orderLines);
    }

    this.pushOrders(orderLines, params);
  }

  /**
   * Walk the export around the order CSVs for the digital sidecar files. The
   * ownership records nest as Additional Data/Digital.Content.Ownership/*.json
   * (one JSON object per owned item), the Appstore entitlements as
   * Appstore.Entitlements/datasets/PDI/PDI.csv — identified by header, since
   * "PDI.csv" alone names nothing — the music library as "Your Music
   * Library"/Saved Music.csv, and Digital Orders.csv sits beside
   * Digital Items.csv itself. Depth mirrors kindle_reading's title walk: the
   * deepest target is four levels down, five under a staged drop's wrapper.
   */
  private loadDigitalContext(searchRoot: string, params: ImportParams): DigitalContext {
    const ctx: DigitalContext = {
      ownership: new Map(),
      appAsins: new Set(),
      musicAsins: new Map(),
      subscriptionOrders: new Set(),
    };
    // One ownership record: { resource: { resourceType, ASIN, parent? } }.
    // The parent is the containing thing (a track's album) — as good a type
    // statement as the resource itself, so both land in the map.
    const takeResource = (r: unknown) => {
      if (!r || typeof r !== 'object') {
        return;
      }

      const res = r as { resourceType?: string; ASIN?: string; parent?: unknown };
      const asin = (res.ASIN ?? '').trim();
      if (asin && !/^not available$/i.test(asin) && res.resourceType && !ctx.ownership.has(asin)) {
        ctx.ownership.set(asin, res.resourceType);
      }

      if (res.parent) {
        takeResource(res.parent);
      }
    };

    const walk = (dir: string, depth: number) => {
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const dirent of names) {
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (depth < 6) {
            walk(full, depth + 1);
          }

          continue;
        }

        if (!dirent.isFile()) {
          continue;
        }

        try {
          if (/^Digital\.Content\.Ownership.*\.json$/i.test(dirent.name)) {
            const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
            for (const rec of Array.isArray(parsed) ? parsed : [parsed]) {
              takeResource((rec as { resource?: unknown })?.resource);
            }
          } else if (/^PDI\.csv$/i.test(dirent.name)) {
            for (const row of parseCSV(fs.readFileSync(full, 'utf8'))) {
              if (!('Entitlement Date' in row)) {
                break;
              } // some other PDI.csv

              const asin = (row['ASIN'] ?? '').trim();
              if (asin) {
                ctx.appAsins.add(asin);
              }
            }
          } else if (/^Saved Music\.csv$/i.test(dirent.name)) {
            // The music library names its tracks' and albums' ASINs and file
            // extension — a purchased single that never resolves through the
            // ownership records is still typed by its library row.
            for (const row of parseCSV(fs.readFileSync(full, 'utf8'))) {
              const ext = (row['File Extension'] ?? '').trim().replace(/^\./, '').toLowerCase();
              const mime =
                (ext && !/^not available$/i.test(ext) ? mimeForFile(`track.${ext}`) : undefined) ??
                'audio/mpeg';
              for (const key of ['ASIN', 'Album ASIN']) {
                const asin = (row[key] ?? '').trim();
                if (asin && !/^not available$/i.test(asin) && !ctx.musicAsins.has(asin)) {
                  ctx.musicAsins.set(asin, mime);
                }
              }
            }
          } else if (/^Digital Orders\.csv$/i.test(dirent.name)) {
            for (const row of parseCSV(fs.readFileSync(full, 'utf8'))) {
              const sub = (row['SubscriptionOrderType'] ?? row['Subscription Order Type'] ?? '').trim();
              const oid = (row['OrderId'] ?? row['Order ID'] ?? '').trim();
              if (oid && /^Subscription/i.test(sub)) {
                ctx.subscriptionOrders.add(oid);
              }
            }
          }
        } catch (e) {
          params.log?.('warn', `Failed to read digital sidecar ${dirent.name}`, {
            error: (e as Error).message,
          });
        }
      }
    };

    walk(searchRoot, 0);

    return ctx;
  }

  /**
   * Parse one order CSV, pushing a timeline item per line. The emitted line
   * items are APPENDED to `orderLines` (the export-wide accumulator) rather
   * than rolled up here: the order aggregate is built once for the whole export
   * — see {@link fileImport} and {@link pushOrders}.
   */
  private async processFile(
    fpath: string,
    getDigitalCtx: () => DigitalContext,
    params: ImportParams,
    orderLines: Item[],
  ): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    // Strip UTF-8 BOM before parsing.
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    // One ORDER LINE — not one CSV row — becomes one item. Amazon splits a
    // single line across rows in two different ways (see mergeLine and
    // ledgerFields), so rows are grouped on the identity first and merged after.
    const ledger = isComponentLedger(rows);
    const audible = isAudiblePurchaseFile(rows);
    const digital = isDigitalContentFile(base) || audible;
    const gamesFile = /DigitalSoftwareAndVideogames/i.test(base);
    const digitalCtx = digital ? getDigitalCtx() : EMPTY_DIGITAL_CONTEXT;
    const groups = new Map<string, Record<string, string>[]>();
    for (const row of rows) {
      try {
        const id = this.admit(row, base, params);
        if (!id) {
          continue;
        }

        const seen = groups.get(id);
        if (seen) {
          seen.push(row);
        } else {
          groups.set(id, [row]);
        }
      } catch (e) {
        params.log?.('error', `Failed to read row in ${base}`, { error: (e as Error).message });
      }
    }

    const lines: Item[] = [];
    for (const [id, lineRows] of groups) {
      try {
        const item = this.pushLine(id, lineRows, ledger, digital, gamesFile, digitalCtx, params);
        if (item) {
          lines.push(item);
        }
      } catch (e) {
        params.log?.('error', `Failed to import line in ${base}`, { error: (e as Error).message });
      }
    }

    orderLines.push(...lines);
  }

  /**
   * One 'order' item per order id — the ACT of purchasing, which becomes the
   * order's single timeline EVENT in CI-Server (kind commerce.order → events).
   * The per-line items above are the THINGS and keep their things/content
   * homes; without this, a five-item order was either five timeline events or
   * none. Aggregated from the emitted lines, so dropped rows (cancelled,
   * unfulfilled) and out-of-timeframe lines never contribute.
   *
   * READ-ONLY over `lines`. Each line already carries its own
   * `ReceiptRollupId` (see pushLine) — this method must never write back onto
   * an item it was handed, because by the time it runs those items have been
   * pushed and, past the flush threshold, already written.
   */
  private pushOrders(lines: Item[], params: ImportParams): void {
    interface OrderAgg {
      ts?: Date;
      total?: number;
      /** The order's money breakdown — the sum of its lines', component by component. */
      breakdown: Record<BreakdownField, number | undefined>;
      currency?: string;
      products: string[];
      /** The order's receipt lines, in CSV order — see the LineItems note below. */
      lineItems: LineItemRecord[];
    }
    const orders = new Map<string, OrderAgg>();
    for (const line of lines) {
      const m = line.metadata ?? {};
      const oid = typeof m['Order ID'] === 'string' ? m['Order ID'] : '';
      if (!oid) {
        continue;
      } // no real order id — nothing to aggregate under

      let agg = orders.get(oid);
      if (!agg) {
        agg = { products: [], lineItems: [], breakdown: emptyBreakdown() };
        orders.set(oid, agg);
      }

      if (line.timestamp && (!agg.ts || line.timestamp < agg.ts)) {
        agg.ts = line.timestamp;
      }

      // `amount`, not `Number`: eleven orders in a real export state a total
      // with a thousands separator ("11,437.78"), and `Number.isFinite(NaN)`
      // silently dropped every one of them — roughly $34k that reached the
      // spend chart as an order with no `Amount` at all. See {@link amount}.
      const total = numeric(m.Total);
      if (total !== undefined) {
        agg.total = (agg.total ?? 0) + total;
      }

      // Component by component, from the lines that state each one. A line that
      // states no tax contributes no tax; it does not contribute a zero, so an
      // order of dialects that carry no breakdown at all keeps an empty one
      // rather than claiming a tax of 0.00.
      for (const field of BREAKDOWN_FIELDS) {
        const v = numeric(m[field]);
        if (v !== undefined) {
          agg.breakdown[field] = (agg.breakdown[field] ?? 0) + v;
        }
      }

      if (!agg.currency && typeof m.Currency === 'string') {
        agg.currency = m.Currency;
      }

      if (typeof m.Product === 'string' && m.Product) {
        agg.products.push(m.Product);
      }

      // The itemisation, which is what makes the order a RECEIPT rather than
      // just an event (push/canonical.ts destinationsFor: a commerce.* record
      // carrying LineItems also routes to `receipts`).
      //
      // LINE NUMBER STABILITY: `lines` is built by iterating each CSV in file
      // order, over a sorted file list, so a re-import of the same export
      // produces the same sequence and therefore the same line numbers — which
      // are half of a line's identity server-side. It is stated explicitly
      // rather than left to the array index so a future change to the receipt
      // mapper cannot renumber them.
      agg.lineItems.push({
        LineNumber: agg.lineItems.length + 1,
        Product: primitive(m.Product),
        Quantity: primitive(m.Quantity),
        'Unit Price': primitive(m['Unit Price']),
        Total: primitive(m.Total),
        // The line's own money, carried through VERBATIM rather than folded
        // into `Total`. `Total` is what the line was CHARGED (tax in) and the
        // order total sums it; `Subtotal` is the line's own pre-tax extended
        // price, which is what `ci.receipt_line_items.total_price_minor` means.
        // One place decides which of the two becomes that column —
        // `push/inputs.ts lineFrom` — so the entry does not have to pre-empt it.
        Subtotal: primitive(m.Subtotal),
        Tax: primitive(m.Tax),
        Shipping: primitive(m.Shipping),
        Discount: primitive(m.Discount),
        Currency: primitive(m.Currency),
        Category: primitive(m.Category),
        Identifiers: Array.isArray(m.Identifiers) ? (m.Identifiers as ObjectIdentifierRef[]) : undefined,
        // The digital/physical evidence the line carried, so the receipt
        // mapper's per-line verdict matches the line's own routing.
        IsDigital: primitive(m.Digital),
      });
    }

    for (const [oid, agg] of orders) {
      const count = agg.products.length || 1;
      const summary = agg.products.join('\n');
      // Report, don't paper over: an order whose parts do not add up to what it
      // charged has something this parser cannot see (an unstated promotion, a
      // state recycling fee), and the breakdown it is about to write is wrong
      // in a way no reader could detect. 3 of 495 orders in a real export fail
      // it. See {@link reconcileOrder} for what "fail" means and what happens
      // to the numbers.
      const mismatch = reconcileOrder(agg.breakdown, agg.total);
      if (mismatch) {
        params.log?.('warn', `Amazon order ${oid} does not reconcile: ${mismatch}`, { orderId: oid });
      }

      params.pipeline.push({
        item: {
          // Distinct namespace from the line ids (`amazon:<oid>:<ident>`), and
          // just as position-free: a re-export maps onto the same event. The
          // SAME string each line already carries as its `ReceiptRollupId` —
          // see orderRollupId and pushLine.
          id: orderRollupId(oid),
          classification: 'order',
          timestamp: agg.ts,
          content: { filename: 'order.txt', mediaType: 'text/plain', data: async () => Buffer.from(summary) },
          metadata: {
            Title: `Amazon order — ${count} item${count === 1 ? '' : 's'}`,
            // The product list rides in Description so the event embeds and
            // searches on what was bought, not just the constant title.
            Description: summary || undefined,
            'Order ID': oid,
            'Item Count': count,
            Total: money(agg.total),
            // Also under `Amount` — the key LifeStatsService's spend chart
            // reads (`amountToMinorSql` is `metadata->>'Amount'`, the
            // convention coinbase.ts and venmo.ts already follow). `Total` was
            // the only key written here, so a real import with $45.8k across
            // 619 orders showed a Spending panel that said to go import
            // purchase history — which was already sitting there, unread.
            Amount: money(agg.total),
            // The order's money BREAKDOWN — `ci.receipts.subtotal_minor`,
            // `tax_minor`, `shipping_minor` and `discount_minor`, which were
            // NULL on every Amazon receipt because nothing ever wrote them.
            // Canonical keys (push/commerceKeys.ts), summed from the lines'
            // own components; omitted, not zeroed, when no line stated one.
            Subtotal: money(agg.breakdown.Subtotal),
            Tax: money(agg.breakdown.Tax),
            Shipping: money(agg.breakdown.Shipping),
            Discount: money(agg.breakdown.Discount),
            // The disagreement in words, recorded on the ROW as well as logged:
            // `params.log` reaches the server log and nothing else, so without
            // this a reader of the order has no way to see that its breakdown
            // is suspect. Absent on an order that reconciles.
            //
            // Distinct key from the receipt's own `TotalsMismatch`, which
            // `push/inputs.ts` writes as the same fact in minor units — one key
            // per shape, so no reader has to test which it got.
            TotalsMismatchNote: mismatch,
            Currency: agg.currency,
            LineItems: agg.lineItems,
            // CANONICAL merchant key (push/commerceKeys.ts): the receipt header
            // needs a merchant, and for a "Your Orders" export it is Amazon.
            Merchant: 'Amazon',
            Source: 'Amazon',
          },
        },
      });
    }
  }

  /** The identity a row belongs under, or null when it is not an importable purchase. */
  private admit(row: Record<string, string>, base: string, params: ImportParams): string | null {
    if (!col(row, ...DATE_COLS)) {
      return null;
    } // skip rows with no Order Date

    const ts = rowTimestamp(row);
    if (!timeframeContains(params.timeframe, ts)) {
      return null;
    }

    const reason = dropReason(row);
    if (reason) {
      params.pipeline.drop?.(reason, col(row, ...PRODUCT_COLS));

      return null;
    }

    // A digital line whose product name Amazon redacted to "Not Applicable"
    // (a handful of small rentals in a real export) describes nothing — the
    // row has an ASIN and a price but no product, so a content row built from
    // it is an unlabeled mystery. Dropped, and counted in the ledger.
    if (isDigitalContentFile(base) && !realProductName(row)) {
      params.pipeline.drop?.('unnamed_product', realAsin(row['ASIN'] ?? '') || undefined);

      return null;
    }

    return rowIdentity(row, col(row, ...ORDER_ID_COLS) || '', base);
  }

  /**
   * A subscription line — a service fee (Prime, Kindle Unlimited, an Audible
   * plan), not a thing. Two sources of the same fact, per dialect: the ledger
   * carries its own `Subscription Order Type` column on every row, where
   * Digital Items.csv states it only order-level in the sibling
   * Digital Orders.csv (joined by order id in loadDigitalContext).
   */
  private isSubscriptionLine(
    primary: Record<string, string>,
    orderId: string | undefined,
    ctx: DigitalContext,
  ): boolean {
    const own = (col(primary, 'Subscription Order Type', 'SubscriptionOrderType') ?? '').trim();
    if (/^Subscription/i.test(own)) {
      return true;
    }

    return !!orderId && ctx.subscriptionOrders.has(orderId);
  }

  /**
   * The digital good's media mimetype, where Amazon states or implies it —
   * undefined when nothing does (the line keeps its text/plain stub rather
   * than a guessed type). Precedence runs strongest-signal-first: the Audible
   * marketplace, the ownership records, the Appstore entitlements, and the
   * music library are per-item statements. What none of them claims falls to
   * INFERENCE: everything else Amazon sells digitally on the retail
   * marketplace is, overwhelmingly, video — the ownership records name every
   * ebook, song, and app, so the residue is video purchases whether or not
   * they were ever streamed. Assumed mp4. The known non-video residue is
   * excluded by name (software/game codes/services — NON_VIDEO_NAME_RE), by
   * file (`gamesFile`: the DigitalSoftwareAndVideogames entitlements are
   * games by definition), and by having no real product name at all.
   */
  private digitalMimetype(
    primary: Record<string, string>,
    asin: string,
    product: string,
    audibleFile: boolean,
    gamesFile: boolean,
    ctx: DigitalContext,
  ): string | undefined {
    if (audibleFile || (primary['Marketplace'] ?? '').trim().toLowerCase() === 'www.audible.com') {
      return 'audio/vnd.audible.aax';
    }

    const owned = asin ? ctx.ownership.get(asin) : undefined;
    if (owned && RESOURCE_TYPE_MIME[owned]) {
      return RESOURCE_TYPE_MIME[owned];
    }

    if (asin && ctx.appAsins.has(asin)) {
      return 'application/vnd.android.package-archive';
    }

    if (asin && ctx.musicAsins.has(asin)) {
      return ctx.musicAsins.get(asin);
    }

    const name = normTitle(product);
    if (!name || name === 'not applicable' || name === 'not available') {
      return undefined;
    }

    if (gamesFile || NON_VIDEO_NAME_RE.test(name)) {
      return undefined;
    }

    return 'video/mp4';
  }

  private pushLine(
    id: string,
    lineRows: Record<string, string>[],
    ledger: boolean,
    digital: boolean,
    gamesFile: boolean,
    digitalCtx: DigitalContext,
    params: ImportParams,
  ): Item {
    // Amazon repeats a row verbatim in some exports. An exact duplicate is not
    // a second shipment or a second component, so it must be discarded BEFORE
    // any summing — otherwise it doubles the quantity it duplicates.
    const rows = dedupeIdenticalRows(lineRows);
    const primary = rows[0];
    const product = col(primary, ...PRODUCT_COLS) || '';
    // Earliest of the line's rows: a split shipment carries one Order Date, but
    // taking the minimum is right regardless and never depends on row order.
    const ts = rows
      .map(rowTimestamp)
      .filter((d): d is Date => d !== undefined)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    // Modern "Retail.OrderHistory.*.csv" carries the product taxonomy in a
    // `Category` column (Amazon's internal product type, e.g. ELECTRONIC_CABLE,
    // ABIS_BOOK, ABIS_KITCHEN) plus an ASIN/ISBN identifier. Surface both so the
    // CI-Server things mapping can record a real category instead of the
    // single generic "commerce" bucket. Header names vary slightly across export
    // vintages, so accept the common aliases.
    const category = primary['Category'] || primary['Product Category'] || '';
    // Only a REAL asin reaches metadata — `_ASINLESS_` was being forwarded to
    // CI-Server as identifierCodes.asin, as though it identified a product.
    const asin = realAsin(primary['ASIN'] || primary['ASIN/ISBN'] || primary['ISBN'] || '');
    const condition = primary['Product Condition'] || primary['Condition'] || '';
    // Audible only (the dialect is row-shaped, so the primary row carries it):
    // was this bought with cash or a membership credit? Named `Payment`, not the
    // column's own `Type` — mapping.ts reads metadata.Type as a category
    // taxonomy, which CREDIT/CASH is not.
    const audibleFile = isAudiblePurchaseFile(rows);
    const payment = audibleFile ? audiblePayment(primary) : undefined;

    const orderId = col(primary, ...ORDER_ID_COLS);
    // A subscription fee is a service, not content: it gets no mimetype, and
    // metadata.Subscription routes it out of the content table entirely
    // (mapping.destinationsFor) — the per-order commerce.order event still
    // marks the purchase. The mimetype below is the bought THING's type, not
    // the text stub's; these items carry no file path, so nothing tries to
    // upload the stub as media bytes.
    const subscription = digital && this.isSubscriptionLine(primary, orderId, digitalCtx);
    const mediaType =
      digital && !subscription
        ? this.digitalMimetype(primary, asin, product, audibleFile, gamesFile, digitalCtx)
        : undefined;

    const item: Item = {
      id,
      classification: 'purchase',
      timestamp: ts,
      // A digital line no signal could type carries NO mimetype — better no
      // claim than a wrong one (text/plain described the stub, not the good).
      // Physical lines keep the stub's honest text/plain; nothing reads it.
      content: {
        filename: 'purchase.txt',
        mediaType: digital ? mediaType : 'text/plain',
        data: async () => Buffer.from(product),
      },
      metadata: {
        Product: product || undefined,
        ...(ledger ? ledgerFields(rows) : mergeLine(rows)),
        // The purchase date, restated in metadata: content rows have no time
        // column in CI-Server (CreateContentInput carries none), so without
        // this a digital purchase arrived with no date anywhere — not even in
        // source_data.
        'Order Date': ts?.toISOString(),
        'Order ID': orderId,
        // The order aggregate this line is already itemised on, stamped BEFORE
        // the push below — never patched onto the item afterwards.
        //
        // Without it a five-item order produces five single-line receipts AND
        // the itemised one (push/canonical.ts `isRolledUp`). It used to be
        // stamped by pushOrders, after the whole export had been pushed, on the
        // theory that the pipeline holds the graph by reference until a later
        // flush. StagedWriter does hold it by reference — and splices the batch
        // out and writes it the moment `push` reaches the flush threshold, many
        // awaits before the export finishes. On a 10-file × 100-line export
        // that left 500 of 1,000 lines marker-less and duplicated their orders.
        // A marker is part of the record's identity, so it is computed where
        // the record is: here.
        ReceiptRollupId: orderId ? orderRollupId(orderId) : undefined,
        Category: category || undefined,
        ASIN: asin || undefined,
        // Canonical identifier list (push/canonical.ts CanonicalRecord.
        // identifiers). `ASIN` above stays for back-compat with readers of the
        // old flat key; this is the one the product-model / observation lanes
        // read.
        Identifiers: identifiersFor(asin),
        Condition: condition || undefined,
        Payment: payment,
        // Routes the record to `content` instead of `things` — see
        // isDigitalContentFile. Only ever set true; left off otherwise so the
        // mapping's product-name heuristic still decides for other files.
        Digital: digital || undefined,
        Subscription: subscription || undefined,
        Source: 'Amazon',
      },
    };
    params.pipeline.push({ item });

    return item;
  }
}

registerDataSource({
  name: 'amazon',
  title: 'Amazon',
  icon: '',
  description: 'Order history from an Amazon "Your Orders" data export CSV.',
  newFileImporter: () => new AmazonFileImporter(),
});
