import type { StagedItem } from '../../entities/StagedItemEntity';
import { toCanonical, type CanonicalRecord } from '../canonical';
import { COMMERCE_KEYS, nonCanonicalCommerceKeys, readCommerceField } from '../commerceKeys';
import { toThingInput } from '../inputs';

/**
 * The canonical commerce vocabulary, and the four values a careless version of
 * it silently changed.
 *
 * ## Why the differential half of this file exists
 *
 * The first attempt at `commerceKeys` in the retired importer replaced each
 * inline fallback chain in the things mapper wholesale. That is not a
 * refactor: a chain FILLS a field that resolved to nothing, and replacing an
 * existing chain with a longer one RE-RANKS a field that already resolved. Four
 * live values moved, with nothing in the diff that looked like a behaviour
 * change and no migration behind any of them:
 *
 *   1. brand — a `Merchant` began beating the `Seller` that shipped the thing;
 *   2. purchase price — a unit `Price` jumped ahead of a stated `Total`,
 *      halving the recorded spend on every row carrying both;
 *   3. brand again — a payment `Processor` became a brand;
 *   4. purchase price again — the TOTAL chain reaches PayPal/Venmo SIGNED
 *      ledger columns, so a refund produced a NEGATIVE purchase price.
 *
 * Each case below is written DIFFERENTIALLY: it states both what the field must
 * resolve to and what the naive chain would have resolved to, so a future
 * "simplification" that collapses the two precedences fails here rather than in
 * somebody's things a month later.
 */

function stagedRow(metadata: Record<string, unknown>, overrides: Partial<StagedItem> = {}): StagedItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    dataSource: 'amazon',
    classification: 'purchase',
    contentHash: 'hash-1',
    occurredAt: new Date('2024-03-02T10:00:00Z'),
    timespanEnd: null,
    latitude: null,
    longitude: null,
    filename: null,
    mediaType: null,
    originalLocation: null,
    intermediateLocation: null,
    metadata,
    createdAt: new Date('2026-08-12T00:00:00Z'),
    ...overrides,
  } as StagedItem;
}

function recordFor(metadata: Record<string, unknown>): CanonicalRecord {
  return toCanonical(stagedRow(metadata));
}

describe('readCommerceField', () => {
  it('prefers the canonical key over every alias', () => {
    expect(readCommerceField({ 'Order ID': 'A', OrderId: 'B', 'Transaction ID': 'C' }, 'ORDER_ID')).toBe('A');
  });

  it('walks the chain in order for a row that states only an alias', () => {
    // The three holes this module was written for: google_purchases wrote
    // `OrderId`, google_purchases wrote `Merchant`, reddit wrote `Cost`.
    expect(readCommerceField({ OrderId: 'B' }, 'ORDER_ID')).toBe('B');
    expect(readCommerceField({ Merchant: 'Google' }, 'MERCHANT')).toBe('Google');
    expect(readCommerceField({ Cost: '1.99' }, 'TOTAL')).toBe('1.99');
  });

  it('treats an empty string and an empty array as absent', () => {
    expect(readCommerceField({ Product: '   ', Title: 'Real' }, 'PRODUCT')).toBe('Real');
    expect(readCommerceField({ LineItems: [] }, 'LINE_ITEMS')).toBeUndefined();
  });

  it('returns the raw value, leaving coercion to the caller', () => {
    expect(readCommerceField({ Total: 19.99 }, 'TOTAL')).toBe(19.99);
    expect(readCommerceField({ LineItems: [{ Product: 'x' }] }, 'LINE_ITEMS')).toEqual([{ Product: 'x' }]);
  });

  it('never reads `Processor` as a merchant', () => {
    // reddit.ts writes Stripe/PayPal there alongside a real Merchant. A payment
    // processor is neither the merchant a receipt was issued by nor the brand
    // of the thing bought.
    expect(readCommerceField({ Processor: 'stripe' }, 'MERCHANT')).toBeUndefined();
  });

  it('answers undefined for an absent bag rather than throwing', () => {
    expect(readCommerceField(undefined, 'TOTAL')).toBeUndefined();
    expect(readCommerceField(null, 'TOTAL')).toBeUndefined();
  });
});

describe('nonCanonicalCommerceKeys (the emitter guard)', () => {
  it('reports a field reachable only through the chain', () => {
    expect(nonCanonicalCommerceKeys({ OrderId: 'B' })).toEqual([
      { key: 'OrderId', canonical: COMMERCE_KEYS.ORDER_ID },
    ]);
  });

  it('says nothing when the alias sits alongside its canonical', () => {
    // Uber's `Restaurant` and PayPal's `Transaction ID` are the source's own
    // column names and worth keeping verbatim — as long as the canonical is
    // there for the reader.
    expect(nonCanonicalCommerceKeys({ Merchant: 'Chez X', Restaurant: 'Chez X' })).toEqual([]);
  });

  it('never demands a rename that would destroy information', () => {
    // `Type` is PayPal's transaction type, `Net`/`Gross` its three distinct
    // money columns, `Title` the generic human label. Renaming any of them to a
    // commerce canonical loses what they actually mean.
    expect(nonCanonicalCommerceKeys({ Type: 'Express Checkout Payment', Net: '-12.00', Title: 'x' })).toEqual(
      [],
    );
  });
});

describe('toThingInput precedence is preserved, not re-ranked', () => {
  it('keeps Seller ahead of Merchant for brand', () => {
    // CASE 1. `Brand → Manufacturer → Seller` is what this field has always
    // meant; the merchant chain only FILLS a brand that resolved to nothing.
    const rec = recordFor({ Product: 'Cable', Seller: 'Acme Supply', Merchant: 'BigMarket' });

    expect(toThingInput(rec).brand).toBe('Acme Supply');
    // …and the naive answer, for contrast: the canonical chain alone.
    expect(readCommerceField(rec.metadata, 'MERCHANT')).toBe('BigMarket');
  });

  it('fills brand from Merchant when nothing else names one', () => {
    // The hole the chain exists to close: google_purchases writes `Merchant`
    // and the old brand chain never read that key, so every Google purchase
    // reached ci.objects with no brand at all.
    expect(toThingInput(recordFor({ Product: 'Nest Doorbell', Merchant: 'Google' })).brand).toBe('Google');
  });

  it('never lets a payment processor become a brand', () => {
    // CASE 3. reddit.ts writes `Processor: stripe` beside `Merchant: Reddit`.
    expect(toThingInput(recordFor({ Product: '500 Coins', Processor: 'stripe' })).brand).toBeUndefined();
  });

  it('keeps a stated Total ahead of a unit Price', () => {
    // CASE 2. `Price` is a UNIT_PRICE alias. With one flat chain it jumps ahead
    // of `Total` and halves the recorded spend on every row carrying both.
    const rec = recordFor({ Product: 'Boots', Total: '120.00', Price: '60.00' });

    expect(toThingInput(rec).purchasePrice).toBe(120);
    expect(readCommerceField(rec.metadata, 'UNIT_PRICE')).toBe('60.00');
  });

  it('still prefers a stated Unit Price over Total, as it always has', () => {
    expect(
      toThingInput(recordFor({ Product: 'Boots', 'Unit Price': '60.00', Total: '120.00' })).purchasePrice,
    ).toBe(60);
  });

  it('fills the price from Cost when no other key states one', () => {
    expect(toThingInput(recordFor({ Product: '500 Coins', Cost: '1.99' })).purchasePrice).toBe(1.99);
  });

  it('refuses a negative purchase price outright', () => {
    // CASE 4. The TOTAL chain reaches PayPal/Venmo ledger columns, which are
    // SIGNED: a refund is negative there, and "this item cost -42.50" is not a
    // fact about a purchase.
    const rec = recordFor({ Product: 'Returned lamp', Amount: '-42.50' });

    expect(toThingInput(rec).purchasePrice).toBeUndefined();
    expect(readCommerceField(rec.metadata, 'TOTAL')).toBe('-42.50');
  });

  it('reads the order id through the chain', () => {
    // google_purchases wrote `OrderId`; the mapper read `Order ID`. Every
    // Google order id was dropped.
    expect(toThingInput(recordFor({ Product: 'x', OrderId: 'GPA.1234' })).identifierCodes).toMatchObject({
      order_id: 'GPA.1234',
    });
  });

  it('keeps the category chain in its original order', () => {
    expect(
      toThingInput(recordFor({ Product: 'x', Type: 'Fallback', 'Product Category': 'Electronics' })).category,
    ).toBe('Electronics');
  });

  it('writes the model column the DTO has always had', () => {
    expect(toThingInput(recordFor({ Product: 'Mouse', Model: 'MX Master 3S' })).model).toBe('MX Master 3S');
  });

  it('writes a whole positive quantity and refuses a fractional one', () => {
    expect(toThingInput(recordFor({ Product: 'x', Quantity: 3 })).quantity).toBe(3);
    // "0.75 kg of apples" is a weight, which this column cannot express.
    expect(toThingInput(recordFor({ Product: 'x', Quantity: 0.75 })).quantity).toBeUndefined();
  });

  it('carries normalized identifiers into the codes bag beside the raw ASIN', () => {
    const rec = recordFor({
      Product: 'Some Book',
      ASIN: '0306406152',
      Identifiers: [{ namespace: 'asin', value: '0306406152' }],
    });

    // The all-digit "ASIN" is an ISBN-10, and the shared normalizer upconverts
    // it — so the normalized code is NOT the raw cell, which is exactly why
    // both are kept.
    expect(toThingInput(rec).identifierCodes).toMatchObject({
      asin: '0306406152',
      isbn: '9780306406157',
    });
  });
});
