/*
 * Canonical commerce metadata keys — ONE place that decides what a purchase
 * record's fields are called, and ONE place that knows every spelling a reader
 * will tolerate.
 *
 * WHY THIS FILE EXISTS. The importer's commerce datasources each invented their
 * own metadata vocabulary, and `push/inputs.ts` grew a private fallback chain
 * per field. Where the two disagreed the field silently vanished — the value was
 * in `staged_items.metadata`, and every reader looked somewhere else. Three such
 * holes were live before this module (all verified against the parsers, not
 * assumed):
 *
 *   1. `google_purchases.ts` wrote `OrderId`; `toThingInput` read
 *      `metadata['Order ID']`. Every Google order id was dropped.
 *   2. `google_purchases.ts` wrote `Merchant`; the things brand chain was
 *      `Brand || Manufacturer || Seller` — `Merchant` was never read, so every
 *      Google purchase reached `ci.objects` with no brand and no merchant.
 *   3. `reddit.ts` wrote `Cost`; no price chain read `Cost` (the things lane reads
 *      `Unit Price` then `Total`), so every Reddit purchase had no price.
 *
 * THE RULE. Emitters write the CANONICAL key ({@link COMMERCE_KEYS}). Readers
 * call {@link readCommerceField}, which walks that field's fallback chain — the
 * chain exists for foreign/legacy rows (a generic CSV, a staged row written
 * before a parser was fixed), NOT as a licence for a datasource to invent a
 * spelling. {@link nonCanonicalCommerceKeys} is the guard that keeps emitters
 * honest.
 *
 * ── THE THING THIS MODULE MUST NOT DO ──────────────────────────────────────
 *
 * A chain FILLS a field that resolved to nothing. It must never RE-RANK a field
 * that already resolved. The first attempt at this module in the retired
 * importer replaced each inline chain wholesale, and four live values changed
 * meaning on the next push with no migration behind them:
 *
 *   - brand: a payment-processor `Merchant` began beating the `Seller` that
 *     actually shipped the thing;
 *   - purchase price: a unit `Price` (a UNIT_PRICE alias) jumped ahead of a
 *     stated `Total`, halving the recorded spend on every row carrying both;
 *   - brand again: `Processor` (reddit's Stripe/PayPal) became a brand;
 *   - purchase price again: the TOTAL chain reaches PayPal/Venmo SIGNED ledger
 *     columns, so a refund produced a NEGATIVE purchase price.
 *
 * So: existing fields keep their existing precedence verbatim and use these
 * chains only as a tail; the canonical keys are the primary reader for the NEW
 * receipt / line-item / product-model mappers. `push/__tests__/commerceKeys.test.ts`
 * pins all four cases differentially.
 */

/** The canonical metadata key for each commerce field. */
export const COMMERCE_KEYS = {
  PRODUCT: 'Product',
  ORDER_ID: 'Order ID',
  MERCHANT: 'Merchant',
  UNIT_PRICE: 'Unit Price',
  TOTAL: 'Total',
  /*
   * The four components a TOTAL is made of — `ci.receipts.subtotal_minor`,
   * `tax_minor`, `shipping_minor`, `discount_minor`.
   *
   * SUBTOTAL is doing double duty on purpose, and the two meanings are the same
   * arithmetic at two scales: on a RECEIPT it is the pre-tax sum of the lines,
   * on a LINE it is that line's own pre-tax extended price (quantity × unit
   * price). `TOTAL` on the same bag is what was CHARGED — tax, shipping and
   * discount already applied — which is why a line needs both and why
   * `total_price_minor` reads SUBTOTAL first (see `inputs.ts lineFrom`).
   *
   * DISCOUNT is a POSITIVE MAGNITUDE, the amount taken OFF: the invariant is
   * `subtotal + tax + shipping − discount = total`. Sources that state it
   * signed (Amazon writes `'-89'`) normalise in their own parser, where the
   * sign convention is a provable fact about that export rather than a guess
   * here.
   */
  SUBTOTAL: 'Subtotal',
  TAX: 'Tax',
  SHIPPING: 'Shipping',
  DISCOUNT: 'Discount',
  CURRENCY: 'Currency',
  QUANTITY: 'Quantity',
  CATEGORY: 'Category',
  CONDITION: 'Condition',
  LINE_ITEMS: 'LineItems',
  IDENTIFIERS: 'Identifiers',
} as const;

/** A commerce field name (the key of {@link COMMERCE_KEYS}). */
export type CommerceField = keyof typeof COMMERCE_KEYS;

/**
 * Every key a reader accepts for a field, canonical FIRST. Order is the
 * precedence: the first key present with a non-empty value wins.
 *
 * These chains are a superset of the ones scattered through `push/inputs.ts`,
 * and the pre-existing order within each is preserved so no record changes
 * meaning by moving here — with ONE deliberate subtraction, `Type` from
 * CATEGORY, argued at that entry.
 */
const FALLBACKS: Record<CommerceField, readonly string[]> = {
  // 'Item Name' is Uber Eats' per-line column; Title/Name are the generic last
  // resorts every importer already fills.
  PRODUCT: [COMMERCE_KEYS.PRODUCT, 'Item Name', 'Product Name', 'Title', 'Name'],
  // 'Transaction ID' is last: PayPal/Venmo have no order id, and their
  // transaction id is the closest thing to one.
  ORDER_ID: [
    COMMERCE_KEYS.ORDER_ID,
    'OrderId',
    'OrderID',
    'Order Id',
    'Order Number',
    'OrderNumber',
    'Transaction ID',
  ],
  // NOT in this chain: `Processor`. It is the PAYMENT processor (reddit.ts
  // writes Stripe/PayPal alongside a real `Merchant`), and Stripe is neither
  // the merchant a receipt was issued by nor the brand of the thing bought.
  MERCHANT: [
    COMMERCE_KEYS.MERCHANT,
    'Merchant Name',
    'MerchantName',
    'Seller',
    'Store',
    'Vendor',
    'Restaurant',
  ],
  UNIT_PRICE: [COMMERCE_KEYS.UNIT_PRICE, 'UnitPrice', 'Item Price', 'Price'],
  // 'Total' first (Amazon), then the per-dialect spellings: Amazon's raw
  // column, Uber Eats' order price, Venmo's amount, PayPal's net/gross,
  // Reddit's cost.
  TOTAL: [COMMERCE_KEYS.TOTAL, 'Total Owed', 'Order Price', 'Amount', 'Net', 'Gross', 'Cost'],
  // The breakdown chains carry the spellings `toReceiptInput` already read
  // inline before this module owned the vocabulary, plus each retail export's
  // own column name — an emitter that has not been converted yet still
  // resolves, which is what the chains are for.
  SUBTOTAL: [COMMERCE_KEYS.SUBTOTAL, 'Sub Total', 'Subtotal Amount', 'Item Subtotal'],
  TAX: [COMMERCE_KEYS.TAX, 'Tax Amount', 'Sales Tax', 'Total Tax'],
  SHIPPING: [COMMERCE_KEYS.SHIPPING, 'Shipping Charge', 'Shipping Cost', 'Delivery Fee'],
  DISCOUNT: [COMMERCE_KEYS.DISCOUNT, 'Discounts', 'Total Discounts', 'Promotion'],
  CURRENCY: [COMMERCE_KEYS.CURRENCY, 'Currency Code', 'CurrencyCode'],
  QUANTITY: [COMMERCE_KEYS.QUANTITY, 'Qty', 'Item Quantity'],
  // NOT in this chain: `Type`. It is PayPal's and Venmo's generic TRANSACTION
  // type ('Express Checkout Payment', 'Subscription Payment'), not a product
  // taxonomy — and no parser writes a product category under it (spotify's
  // 'podcast', apple_health's and gpx's are not commerce records at all). It
  // was here because `toThingInput` read it inline, which put PayPal
  // transaction types into `ci.objects.category`; harmless-looking until the
  // chain gained a SECOND reader. `isDigitalGood` matches DIGITAL_CATEGORY_RE
  // against CATEGORY, so `Type: 'Subscription Payment'` on a cast-iron pan
  // declared it a digital good and routed the purchase to `ci.content` instead
  // of `ci.objects` — an object moved out of the things table by a payment
  // method. Dropping it deliberately changes the pre-existing object
  // behaviour, in the direction of not writing a payment type as a category.
  CATEGORY: [COMMERCE_KEYS.CATEGORY, 'Product Category', 'Product Type'],
  CONDITION: [COMMERCE_KEYS.CONDITION, 'Product Condition'],
  LINE_ITEMS: [COMMERCE_KEYS.LINE_ITEMS, 'Line Items'],
  IDENTIFIERS: [COMMERCE_KEYS.IDENTIFIERS],
};

/**
 * Chain entries that are NOT emitter mistakes: keys with a legitimate meaning
 * of their own that a reader merely accepts as a last resort.
 *
 * `Type` is PayPal's transaction type and Venmo's; `Amount`/`Net`/`Gross` are
 * PayPal's three distinct money columns; `Title`/`Name` are the generic
 * human-label keys every importer fills. Renaming any of them to a commerce
 * canonical would DESTROY information, so the emitter guard
 * ({@link nonCanonicalCommerceKeys}) must not demand it.
 *
 * `Type` is listed here although no chain reads it any longer (see CATEGORY):
 * the two statements are independent, and re-adding it to a chain must not also
 * turn it into a rename demand.
 */
const AMBIGUOUS_ALIASES: ReadonlySet<string> = new Set([
  'Title',
  'Name',
  'Type',
  'Price',
  'Amount',
  'Net',
  'Gross',
  // Uber's export column, kept verbatim next to a canonical `Total`.
  'Order Price',
]);

/** Every non-canonical spelling a reader tolerates, mapped to its canonical key. */
const ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = new Map(
  (Object.keys(FALLBACKS) as CommerceField[]).flatMap((field) =>
    FALLBACKS[field]
      .slice(1)
      .filter((alias) => !AMBIGUOUS_ALIASES.has(alias))
      .map((alias) => [alias, COMMERCE_KEYS[field]] as [string, string]),
  ),
);

/** Is this metadata value worth reading (present, and not an empty string/array)? */
function present(v: unknown): boolean {
  if (v === undefined || v === null) {
    return false;
  }

  if (typeof v === 'string') {
    return v.trim().length > 0;
  }

  if (Array.isArray(v)) {
    return v.length > 0;
  }

  return true;
}

/**
 * The value of one commerce field, resolved through its fallback chain.
 *
 * Returns the RAW metadata value (string, number, array, …) — coercion stays
 * with the caller, which already owns the sanitising `str()`/`num()` helpers
 * (`push/canonical.ts`). Returns `undefined` when no key in the chain carries a
 * value.
 */
export function readCommerceField(
  metadata: Record<string, unknown> | undefined | null,
  field: CommerceField,
): unknown {
  if (!metadata) {
    return undefined;
  }

  for (const key of FALLBACKS[field]) {
    const v = metadata[key];

    if (present(v)) {
      return v;
    }
  }

  return undefined;
}

/**
 * The commerce fields a record states ONLY under a non-canonical key, as
 * `{ key, canonical }` pairs.
 *
 * A reader still resolves these (that is what the chains are for), so this is
 * not a data-loss report — it is the EMITTER guard: a datasource of ours that
 * writes `OrderId` and no `Order ID` is one refactor away from the field
 * disappearing, and a chain entry is not a substitute for writing the canonical
 * name.
 *
 * An alias that sits ALONGSIDE its canonical is fine, and deliberately so: a
 * source's own column name is worth keeping verbatim (Uber's `Restaurant`,
 * PayPal's `Transaction ID`) as long as the canonical is there for the reader.
 * What the guard forbids is a field reachable only through the chain.
 */
export function nonCanonicalCommerceKeys(
  metadata: Record<string, unknown> | undefined | null,
): Array<{ key: string; canonical: string }> {
  if (!metadata) {
    return [];
  }

  const out: Array<{ key: string; canonical: string }> = [];

  for (const key of Object.keys(metadata)) {
    if (!present(metadata[key])) {
      continue;
    }

    const canonical = ALIAS_TO_CANONICAL.get(key);

    if (canonical && !present(metadata[canonical])) {
      out.push({ key, canonical });
    }
  }

  return out;
}
