import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GooglePurchasesFileImporter } from '../google_purchases';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';
import { metaText } from './support/emitted';

const ROOT = path.join(__dirname, 'fixtures', 'google_purchases', 'Purchases & Reservations');

async function run() {
  const fi = new GooglePurchasesFileImporter();
  const pipeline: EmittedGraph[] = [];
  await fi.fileImport({}, { filename: 'Purchases & Reservations', fullPath: ROOT }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline.filter((p) => p.item).map((p) => p.item);
}

/**
 * Runs a single synthetic action_*.json (an `order` record) through the
 * importer's private pushPurchase() path and returns the resulting item's
 * metadata. Used to exercise the Total/Currency money-shape fallback chain
 * (pushPurchase, google_purchases.ts ~L264-271) branch by branch, since the
 * checked-in fixture only ever hits one of its four shapes.
 */
async function runOrder(order: Record<string, unknown>) {
  return runRecord({ order, uniqueId: 'synthetic' });
}

/** Runs one synthetic action_*.json record and returns the item it produced. */
async function runRecord(record: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpurchases-action-'));
  try {
    const file = path.join(dir, 'action_synthetic.json');
    fs.writeFileSync(file, JSON.stringify(record), 'utf8');
    const fi = new GooglePurchasesFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'action_synthetic.json', fullPath: file }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline.filter((p) => p.item).map((p) => p.item)[0];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Google Purchases & Reservations datasource', () => {
  it('recognizes the directory tree', async () => {
    const fi = new GooglePurchasesFileImporter();
    const rec = await fi.recognize({}, { filename: 'Purchases & Reservations', fullPath: ROOT });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('produces items with correct classifications', async () => {
    const items = await run();
    expect(items.length).toBe(2);
    const reservation = items.find((i) => i.id === 'gpurchase:11953315030926749523');
    const purchase = items.find((i) => i.id === 'gpurchase:2228975518603505535');
    expect(reservation?.classification).toBe('event');
    expect(purchase?.classification).toBe('purchase');
  });

  it('sets a meaningful Title (not a bare filename)', async () => {
    const items = await run();
    for (const it of items) {
      expect(typeof it.metadata?.Title).toBe('string');
      expect(metaText(it.metadata.Title).length).toBeGreaterThan(0);
      expect(it.metadata.Title).not.toBe(it.content?.filename);
    }

    const reservation = items.find((i) => i.id === 'gpurchase:11953315030926749523');
    expect(reservation?.metadata?.Title).toBe('Dining Reservation — Cucina Enoteca Irvine');
    expect(reservation?.metadata?.Merchant).toBe('Cucina Enoteca Irvine');
    expect(reservation?.metadata?.PartySize).toBe(4);
    expect(reservation?.metadata?.Address).toContain('Irvine');
    const purchase = items.find((i) => i.id === 'gpurchase:2228975518603505535');
    expect(purchase?.metadata?.Title).toBe('Pixel Buds Pro');
    expect(purchase?.metadata?.Total).toBe(199.99);
    expect(purchase?.metadata?.Currency).toBe('USD');
    expect(purchase?.metadata?.Merchant).toBe('Google Store');
  });

  it('gives every item a truthy, distinct id and parseable timestamp', async () => {
    const items = await run();
    const ids = items.map((i) => i.id!);
    expect(ids.every((id) => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const it of items) {
      expect(it.timestamp instanceof Date).toBe(true);
      expect(isNaN(it.timestamp!.getTime())).toBe(false);
    }

    const reservation = items.find((i) => i.id === 'gpurchase:11953315030926749523');
    expect(reservation?.timestamp?.toISOString()).toBe('2023-07-02T00:00:00.000Z');
  });

  it('is idempotent across re-import', async () => {
    const a = (await run()).map((i) => i.id!).sort();
    const b = (await run()).map((i) => i.id!).sort();
    expect(b).toEqual(a);
  });

  describe('Total/Currency money-shape fallback chain', () => {
    // The checked-in fixture's `order.total` is already a nested
    // { amount, currency } object, so it only ever exercises the
    // priceObj.amount branch below. These cover the sibling branches: a bare
    // scalar Total (no nested object at all), the .value sibling key inside
    // the nested object, and the price/amount top-level scalar fallbacks used
    // when a record has no `total` field. A regression in any one of them
    // would silently turn a real purchase's price into `undefined`.

    it('reads a plain scalar total with no nested money object', async () => {
      const item = await runOrder({ name: 'Widget', total: 49.5 });
      expect(item.metadata?.Total).toBe(49.5);
      expect(item.metadata?.Currency).toBeUndefined();
    });

    it('falls back to the nested `value` key when `amount` is absent', async () => {
      const item = await runOrder({ name: 'Gadget', total: { value: 25.5, currency: 'EUR' } });
      expect(item.metadata?.Total).toBe(25.5);
      expect(item.metadata?.Currency).toBe('EUR');
    });

    it('falls back to a top-level `price` field and top-level `currency` when `total` is absent', async () => {
      const item = await runOrder({ name: 'Thingamajig', price: 12.34, currency: 'GBP' });
      expect(item.metadata?.Total).toBe(12.34);
      expect(item.metadata?.Currency).toBe('GBP');
    });

    it('falls back to a top-level `amount` field when neither `total` nor `price` is present', async () => {
      const item = await runOrder({ name: 'Doohickey', amount: 7.25 });
      expect(item.metadata?.Total).toBe(7.25);
    });
  });

  /**
   * A reservation the user cancelled.
   *
   * Takeout keeps a cancelled booking or waitlist entry and marks it with
   * `canceled: true`. The reference export has five, out of 42 reservations.
   * The importer used to record that only as `metadata.Canceled`, which no
   * reader of `ci.events.status` looks at, so the event was stored
   * `confirmed`. Invented venues throughout.
   */
  describe('a cancelled reservation', () => {
    const booking = {
      name: 'Booking',
      merchantName: 'Harbor Noodle House',
      startTime: '2023-10-22T03:30:00Z',
      endTime: '2023-10-22T04:00:00Z',
      partySize: 2,
      service: 'Reservations & Waitlist',
      address: 'California, 100 Example Way, Laguna Beach, US',
    };

    it("states a cancelled booking as a cancelled event and keeps Google's flag", async () => {
      const item = await runRecord({ booking: { ...booking, canceled: true }, uniqueId: '1001' });

      expect(item.classification).toBe('event');
      expect(item.metadata?.eventStatus).toBe('cancelled');
      expect(item.metadata?.Canceled).toBe(true);
    });

    it('states a cancelled waitlist entry the same way', async () => {
      const item = await runRecord({
        waitlist: {
          name: 'Waitlist',
          merchantName: 'Harbor Noodle House',
          createdTime: '2023-11-04T01:10:00Z',
          partySize: 3,
          service: 'Reservations & Waitlist',
          canceled: true,
        },
        uniqueId: '1002',
      });

      expect(item.metadata?.Kind).toBe('waitlist');
      expect(item.metadata?.eventStatus).toBe('cancelled');
    });

    it('states no status for a booking that was not cancelled', async () => {
      // Explicitly `false`, and absent as in the checked-in fixture. Neither
      // says more than the column DEFAULT, so neither sets a status.
      const kept = await runRecord({ booking: { ...booking, canceled: false }, uniqueId: '1003' });
      const [fixture] = (await run()).filter((item) => item.id === 'gpurchase:11953315030926749523');

      expect(kept.metadata?.Canceled).toBe(false);
      expect(kept.metadata?.eventStatus).toBeUndefined();
      expect(fixture.metadata?.Canceled).toBeUndefined();
      expect(fixture.metadata?.eventStatus).toBeUndefined();
    });

    it('does not read a string as a cancellation', async () => {
      // Only Google's JSON boolean counts. The repair migration selects on the
      // same thing (`metadata @> '{"Canceled": true}'`).
      const item = await runRecord({ booking: { ...booking, canceled: 'true' }, uniqueId: '1004' });

      expect(item.metadata?.eventStatus).toBeUndefined();
      expect(item.metadata?.Canceled).toBeUndefined();
    });
  });
});
