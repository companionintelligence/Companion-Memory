import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { AmazonFileImporter } from '../amazon';
import type { Graph, ImportPipeline, ImportParams, LineItemRecord } from '../timeline';

import type { EmittedGraph, EmittedItem, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** One record as a writer would have persisted it: read at write time, not after. */
interface WrittenRecord {
  id: string | undefined;
  classification: string | undefined;
  metadata: Record<string, unknown>;
}

/**
 * A pipeline that behaves like `staging/StagedWriter`, which is what a real
 * import runs through.
 *
 * The three properties that matter, and that a plain array does not have:
 *
 *   1. it buffers the graph BY REFERENCE, so an importer can still mutate a
 *      pushed item — right up until the buffer is flushed;
 *   2. `push` SPLICES the batch out and schedules a write the moment the buffer
 *      reaches the threshold, in the middle of the parse;
 *   3. the write READS the item (here: a JSON snapshot of its metadata) and is
 *      asynchronous, so it interleaves with the importer's own awaits.
 *
 * Together those are what turn a post-hoc metadata patch into silent, partial
 * data loss: everything already flushed keeps the value it had at write time.
 */
class FlushingPipeline implements ImportPipeline {
  readonly written: WrittenRecord[] = [];

  /** How many batches were written. >1 proves the parse really was interrupted. */
  flushes = 0;

  private readonly buffer: Graph[] = [];

  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly threshold = 500) {}

  push(g: Graph): void {
    this.buffer.push(g);

    if (this.buffer.length >= this.threshold) {
      this.scheduleFlush();
    }
  }

  drop(): void {}

  keep(): void {}

  /** Await every scheduled write, then write what is left. */
  async settled(): Promise<void> {
    await this.chain;
    this.scheduleFlush();
    await this.chain;
  }

  private scheduleFlush(): void {
    const batch = this.buffer.splice(0, this.buffer.length);

    if (batch.length === 0) {
      return;
    }

    this.chain = this.chain.then(async () => {
      // Stand-in for the real write's I/O: whatever the item's metadata says
      // HERE is what lands in the database.
      await Promise.resolve();
      this.flushes += 1;

      for (const graph of batch) {
        if (!graph.item) {
          continue;
        }

        this.written.push({
          id: graph.item.id,
          classification: graph.item.classification,
          metadata: JSON.parse(JSON.stringify(graph.item.metadata ?? {})) as Record<string, unknown>,
        });
      }
    });
  }
}

describe('Amazon datasource', () => {
  it('recognizes export directory by Retail.OrderHistory file', async () => {
    const root = path.join(FIXTURES_DIR, 'amazon-export');
    const fi = new AmazonFileImporter();
    const rec = await fi.recognize({}, { filename: 'amazon-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a single Retail.OrderHistory file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'amazon-export', 'Retail.OrderHistory.1.csv');
    const fi = new AmazonFileImporter();
    const rec = await fi.recognize({}, { filename: 'Retail.OrderHistory.1.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('does not recognize an unrelated directory', async () => {
    const root = path.join(FIXTURES_DIR, 'spotify-export');
    const fi = new AmazonFileImporter();
    const rec = await fi.recognize({}, { filename: 'spotify-export', fullPath: root });
    expect(rec.confidence).toBe(0);
  });

  it('does not recognize a same-named CSV from a different retailer', async () => {
    // "Order History.csv" is boilerplate phrasing several other retailers'
    // own "download your data" exports use verbatim — a Walmart/eBay/Target
    // export with completely different columns must not be claimed on the
    // filename alone. The filename tier used to skip the header check
    // entirely and return 0.95 the moment the name matched.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-amazon-lookalike-'));
    const fpath = path.join(dir, 'Order History.csv');
    fs.writeFileSync(fpath, 'Item,Category,Store,Total\nWidget,Home,Target,19.99\n');

    const fi = new AmazonFileImporter();
    const rec = await fi.recognize({}, { filename: 'Order History.csv', fullPath: fpath });
    expect(rec.confidence).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports order rows into purchase items', async () => {
    const root = path.join(FIXTURES_DIR, 'amazon-export');
    const fi = new AmazonFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'amazon-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 3 valid rows (the row with an empty Order Date is skipped), each in its
    // own order — so 3 purchases plus 3 order-level items.
    const purchases = pipeline.filter((g) => g.item.classification === 'purchase');
    expect(purchases.length).toBe(3);
    expect(pipeline.filter((g) => g.item.classification === 'order').length).toBe(3);

    const first = purchases[0].item;
    expect(first.classification).toBe('purchase');
    expect(first.metadata.Product).toBe('USB-C to USB-C Cable, 6ft (2-Pack)');
    expect(first.metadata.Quantity).toBe(2);
    expect(first.metadata.Total).toBe('19.98');
    expect(first.metadata.Currency).toBe('USD');
    expect(first.metadata['Order ID']).toBe('111-2233445-6677889');
    expect(first.timestamp).toBeInstanceOf(Date);
    expect(first.timestamp!.toISOString()).toBe('2023-01-15T10:30:00.000Z');

    // The order-level event carries the same total under BOTH `Total` and
    // `Amount`. `Amount` is what LifeStatsService's spend chart reads
    // (amountToMinorSql is `metadata->>'Amount'`, the key coinbase.ts and
    // venmo.ts already write) — without it, a real import with $45.8k across
    // 619 orders showed an empty Spending panel telling the user to go import
    // purchase history that was already sitting there, unread.
    const orderEvent = pipeline.find((g) => g.item.classification === 'order')!.item;
    expect(orderEvent.metadata.Amount).toBe(orderEvent.metadata.Total);

    // Date-only "Order Date" parses to a valid timestamp.
    expect(purchases[1].item.metadata.Product).toBe('The Pragmatic Programmer, 20th Anniversary Edition');
    expect(purchases[1].item.timestamp).toBeInstanceOf(Date);

    // Embedded newline + escaped quotes survive the CSV parser.
    expect(purchases[2].item.metadata.Product).toContain('Stainless Steel Water Bottle');
    expect(purchases[2].item.metadata.Product).toContain('"Midnight Black"');
  });

  // A4 — surface the real product taxonomy (Category) + ASIN so object rows
  // get a meaningful category instead of all collapsing into "commerce".
  it('captures the Category, ASIN, and Condition columns into metadata', async () => {
    const root = path.join(FIXTURES_DIR, 'amazon-export');
    const fi = new AmazonFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'amazon-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline[0].item.metadata.Category).toBe('ELECTRONIC_CABLE');
    expect(pipeline[0].item.metadata.ASIN).toBe('B07ABC123');
    expect(pipeline[0].item.metadata.Condition).toBe('New');
    expect(pipeline[1].item.metadata.Category).toBe('ABIS_BOOK');
    expect(pipeline[2].item.metadata.Category).toBe('ABIS_KITCHEN');
  });

  it('respects the timeframe filter', async () => {
    const root = path.join(FIXTURES_DIR, 'amazon-export');
    const fi = new AmazonFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'amazon-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2023-04-01T00:00:00Z') },
      log: () => {},
    } as unknown as ImportParams);

    // Only the 2023-06-19 order is after the since boundary — one purchase and
    // its one order event.
    const purchases = pipeline.filter((g) => g.item.classification === 'purchase');
    const orders = pipeline.filter((g) => g.item.classification === 'order');
    expect(purchases.length).toBe(1);
    expect(purchases[0].item.metadata['Order ID']).toBe('113-5566778-9900112');
    expect(orders.length).toBe(1);
    expect(orders[0].item.metadata['Order ID']).toBe('113-5566778-9900112');
  });

  // Import a CSV body from a temp file. `items` are the per-line 'purchase'
  // graphs; the per-order 'order' items (the timeline events) come back
  // separately as `orders`.
  const importCsv = async (name: string, csv: string) => {
    const fs = await import('node:fs');
    const tmp = path.join(FIXTURES_DIR, 'amazon-export', `${name}.Retail.OrderHistory.csv`);
    await fs.promises.writeFile(tmp, csv);
    try {
      const pipeline: EmittedGraph[] = [];
      const drops: Array<[string, string | undefined]> = [];
      (pipeline as TestPipeline).drop = (reason: string, detail?: string) => drops.push([reason, detail]);
      await new AmazonFileImporter().fileImport({}, { filename: `${name}.csv`, fullPath: tmp }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      const all = pipeline.map((g) => g.item);

      return {
        items: all.filter((i) => i.classification === 'purchase'),
        orders: all.filter((i) => i.classification === 'order'),
        drops,
      };
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  };

  const HEADER =
    '"Order Date","Order ID","Product Name","Quantity","Total Owed","Currency","Unit Price","ASIN"';

  // Regression: rows that share an Order Date (date-only) and product would, with
  // no item.id, collapse to one row via the (data_source, content_hash) dedup. Each
  // distinct line item must carry a stable, unique id and re-import must be idempotent.
  it('assigns stable unique ids so same-day line items do not collapse', async () => {
    const csv = [
      HEADER,
      '"2023-03-02","111-2233445-6677889","Widget","1","10.00","USD","10.00","B07ABC123"',
      '"2023-03-02","111-2233445-6677889","Gadget","1","10.00","USD","10.00","B07XYZ999"',
      '"2023-03-02","112-9988776-5544332","Widget","1","10.00","USD","10.00","B07ABC123"',
    ].join('\n');
    const { items } = await importCsv('__dedup__', csv);
    expect(items.length).toBe(3);
    const ids = items.map((i) => i.id!);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    // Distinct products in one order, and the same product in another order, stay distinct.
    expect(new Set(ids).size).toBe(3);
    // Re-import yields identical ids (idempotent).
    const again = await importCsv('__dedup__', csv);
    expect(again.items.map((i) => i.id!)).toEqual(ids);
  });

  // The id must not encode file position: the export is sorted newest-order-first,
  // so every new order shifts the row index of the entire history. Keying on it
  // re-imported all of it as duplicates on each fresh export.
  it('keeps ids stable when new orders are prepended', async () => {
    const older = [
      '"2023-03-02","111-2233445-6677889","Widget","1","10.00","USD","10.00","B07ABC123"',
      '"2023-01-05","112-9988776-5544332","Gadget","1","20.00","USD","20.00","B07XYZ999"',
    ];
    const before = await importCsv('__shift__', [HEADER, ...older].join('\n'));
    const after = await importCsv(
      '__shift__',
      [
        HEADER,
        '"2023-06-01","113-0000000-0000001","Newest Order","1","5.00","USD","5.00","B07NEW001"',
        ...older,
      ].join('\n'),
    );
    expect(after.items.length).toBe(3);
    // The two pre-existing rows keep the exact ids they had.
    expect(after.items.slice(1).map((i) => i.id!)).toEqual(before.items.map((i) => i.id!));
  });

  // One ORDER LINE is one item. Amazon splits a multi-unit line across a row per
  // shipment, each carrying that shipment's own quantity and amount, so the
  // parts must be summed — keeping one row understated the holding. A
  // byte-identical repeat is NOT a second shipment and must not add to the sum.
  it('sums split-shipment rows of one line and ignores byte-identical repeats', async () => {
    const csv = [
      '"Order Date","Order ID","Product Name","Quantity","Total Owed","Currency","Unit Price","ASIN","Ship Date","Carrier Name & Tracking Number"',
      '"2026-02-01","114-6974509-5422626","Noctua NF-A12x25","3","54.93","USD","16.99","B077PNJNGJ","2026-02-01","AMZN_US(TBA1)"',
      '"2026-02-01","114-6974509-5422626","Noctua NF-A12x25","2","36.62","USD","16.99","B077PNJNGJ","2026-02-18","UPS(1Z9)"',
      // Exact repeat of the first row — Amazon does emit these.
      '"2026-02-01","114-6974509-5422626","Noctua NF-A12x25","3","54.93","USD","16.99","B077PNJNGJ","2026-02-01","AMZN_US(TBA1)"',
    ].join('\n');
    const { items } = await importCsv('__split__', csv);
    expect(items.length).toBe(1);
    expect(items[0].metadata.Quantity).toBe(5); // 3 + 2, NOT 3 + 2 + 3
    expect(items[0].metadata.Total).toBe('91.55');
    expect(items[0].metadata.Shipments).toBe(2);
    expect(items[0].metadata['Unit Price']).toBe('16.99');
  });

  // A line that never split keeps its raw strings exactly, and gains no
  // Shipments marker — only a real merge recomputes.
  it('leaves an unsplit line untouched', async () => {
    const csv = [
      HEADER,
      '"2026-02-01","114-0000000-0000001","Solo Item","1","10.00","USD","10.00","B07SOLO001"',
    ].join('\n');
    const { items } = await importCsv('__solo__', csv);
    expect(items[0].metadata.Quantity).toBe(1);
    expect(items[0].metadata.Total).toBe('10.00');
    expect(items[0].metadata.Shipments).toBeUndefined();
    expect(items[0].metadata.Payment).toBeUndefined(); // Audible-only field
  });

  // `_ASINLESS_` is a sentinel Amazon puts on grocery/Fresh lines, not an id —
  // every item in the order carries it, so keying on it merges distinct products.
  it('distinguishes _ASINLESS_ grocery lines by product name', async () => {
    const csv = [
      HEADER,
      '"2025-02-21","113-7520740-3283408","Strawberries","1","3.99","USD","3.99","_ASINLESS_"',
      '"2025-02-21","113-7520740-3283408","Organic Blueberries","1","6.99","USD","6.99","_ASINLESS_"',
    ].join('\n');
    const { items } = await importCsv('__grocery__', csv);
    expect(items.length).toBe(2);
    expect(new Set(items.map((i) => i.id!)).size).toBe(2);
    // The sentinel must not travel on as if it identified a product.
    expect(items[0].metadata.ASIN).toBeUndefined();
    expect(items[1].metadata.ASIN).toBeUndefined();
  });

  // Cosmetic re-wording of the product name between export vintages must not
  // mint a new id for an ASINLESS row (whitespace/case are normalised).
  it('normalises the product name before hashing the ASINLESS fallback', async () => {
    const a = await importCsv(
      '__norm__',
      [
        HEADER,
        '"2025-02-21","113-7520740-3283408","Organic  Blueberries","1","6.99","USD","6.99","_ASINLESS_"',
      ].join('\n'),
    );
    const b = await importCsv(
      '__norm__',
      [
        HEADER,
        '"2025-02-21","113-7520740-3283408","organic blueberries","1","6.99","USD","6.99","_ASINLESS_"',
      ].join('\n'),
    );
    expect(a.items[0].id).toBe(b.items[0].id);
  });

  // Cancelled/unfulfilled lines keep a Unit Price, which the things mapping
  // reads for purchasePrice — importing them puts full-price phantoms in stock.
  it('skips unfulfilled zero-quantity lines and reports them as drops', async () => {
    const csv = [
      HEADER,
      '"2024-08-13","111-0000000-0000001","Amazon eGift Card","0","0","USD","25.00","B07PCMWTSG"',
      '"2024-08-14","111-0000000-0000002","Real Purchase","1","12.00","USD","12.00","B07REAL001"',
      // Quantity 0 but money still owed under no stated status — left for a human.
      '"2024-08-15","111-0000000-0000003","Owes Money","0","9.99","USD","9.99","B07OWES001"',
      // Blank / "Not Available" cells must not be read as a zero.
      '"2024-08-16","111-0000000-0000004","Blank Total","0","","USD","4.00","B07BLANK01"',
      '"2024-08-17","111-0000000-0000005","NA Total","0","Not Available","USD","4.00","B07NA00001"',
    ].join('\n');
    const { items, drops } = await importCsv('__unfulfilled__', csv);
    expect(items.map((i) => i.metadata.Product)).toEqual([
      'Real Purchase',
      'Owes Money',
      'Blank Total',
      'NA Total',
    ]);
    expect(drops).toEqual([['unfulfilled_line', 'Amazon eGift Card']]);
  });

  // Amazon renames columns between export vintages: the "Your Orders" download
  // says Original Quantity / Total Amount where "All Data Categories" says
  // Quantity / Total Owed. Reading one spelling silently emptied both fields and
  // disabled the unfulfilled-line guard across a whole export.
  it('reads the Your Orders column spellings for quantity and total', async () => {
    const csv = [
      '"Order Date","Order ID","Product Name","Original Quantity","Total Amount","Currency","Unit Price","ASIN","Order Status"',
      '"2026-02-01","114-6974509-5422626","Noctua NF-A12x25","3","54.93","USD","16.99","B077PNJNGJ","Closed"',
      // Zero on BOTH aliased columns still drops as an unfulfilled line.
      '"2026-02-02","114-0000000-0000002","Never Shipped","0","0","USD","16.99","B07NEVR001","Closed"',
    ].join('\n');
    const { items, drops } = await importCsv('__aliases__', csv);
    expect(items.length).toBe(1);
    expect(items[0].metadata.Quantity).toBe(3);
    expect(items[0].metadata.Total).toBe('54.93');
    expect(drops).toEqual([['unfulfilled_line', 'Never Shipped']]);
  });

  // The Digital-Ordering.1 family runs the words together — OrderDate, OrderId,
  // ProductName, OriginalQuantity, OurPrice. Reading only the spaced spellings
  // skipped every row of "Digital Items.csv" at the date gate (207 rows in a
  // real export), and would have keyed any surviving row on the FILENAME
  // (Order ID read as empty).
  it('reads the CamelCase Digital-Ordering column dialect', async () => {
    const csv = [
      'ASIN,ProductName,OrderId,BaseCurrencyCode,OrderDate,OriginalQuantity,OurPrice,OurPriceCurrencyCode',
      '"B00KQPGRRE","Minecraft for PC/Mac [Online Game Code]","D01-8067164-9679435","USD","2015-01-02T17:35:00Z","1","26.95","USD"',
    ].join('\n');
    const { items } = await importCsv('Digital Items', csv);
    expect(items.length).toBe(1);
    const it = items[0];
    // Order id — not the filename — anchors the identity.
    expect(it.id).toBe('amazon:D01-8067164-9679435:B00KQPGRRE');
    expect(it.timestamp?.toISOString()).toBe('2015-01-02T17:35:00.000Z');
    expect(it.metadata.Product).toBe('Minecraft for PC/Mac [Online Game Code]');
    expect(it.metadata['Order ID']).toBe('D01-8067164-9679435');
    expect(it.metadata.Quantity).toBe(1);
    expect(it.metadata['Unit Price']).toBe('26.95');
    expect(it.metadata.Currency).toBe('USD');
    // No total-paid column exists in this dialect (tax lives in a separate
    // ledger file this importer does not join) — absent, not zero.
    expect(it.metadata.Total).toBeUndefined();
    expect(it.metadata.Digital).toBe(true); // filename carries "Digital"
  });

  // Audible's "Purchase History.csv" dates on Order Place Date, counts on
  // Units, and prices on Net Price — the cash actually paid, 0.00 when a
  // membership credit covered it. Regular Price (list) and Price Paid Member
  // (internal bookkeeping, erratic across identical credit buys) are ignored.
  // The filename says nothing, so the dialect is detected from its columns and
  // routed as digital content.
  it('imports the Audible purchase-history dialect on Net Price', async () => {
    const csv = [
      'ASIN,"Consumed Credit",Currency,"Net Price","Order ID","Order Place Date","Price Paid Member","Product Name","Regular Price",Status,Type,Units',
      '"B00SLTNLBogus","1.00","USD","0.00","D01-1111111-1111111","2019-08-30","9.56","Guards! Guards! (Unabridged)","29.99","Completed","CREDIT","1"',
      '"B08G9PRS1K","0.00","USD","6.00","D01-2222222-2222222","2021-07-15","0.00","Tiamat\'s Wrath (Unabridged)","6.00","Completed","CASH","1"',
    ].join('\n');
    const { items } = await importCsv('__audible__', csv);
    expect(items.length).toBe(2);

    const credit = items.find((i) => String(i.metadata.Product).startsWith('Guards'))!;
    expect(credit.id).toBe('amazon:D01-1111111-1111111:B00SLTNLBogus');
    expect(credit.timestamp?.toISOString()).toBe('2019-08-30T00:00:00.000Z');
    // Net Price everywhere — NOT the 9.56 bookkeeping figure or the 29.99 list.
    expect(credit.metadata.Total).toBe('0.00');
    expect(credit.metadata['Unit Price']).toBe('0.00');
    expect(credit.metadata.Quantity).toBe(1);
    expect(credit.metadata.Currency).toBe('USD');
    expect(credit.metadata.Digital).toBe(true);
    // A credit-covered audiobook is not a free one — the 0.00 carries its why.
    expect(credit.metadata.Payment).toBe('CREDIT');

    const cash = items.find((i) => String(i.metadata.Product).startsWith('Tiamat'))!;
    expect(cash.metadata.Total).toBe('6.00');
    expect(cash.metadata['Unit Price']).toBe('6.00');
    expect(cash.metadata.Payment).toBe('CASH');
  });

  // Order Status is Amazon's own verdict and outranks the amount heuristic: a
  // cancelled order can still carry a non-zero Total Owed (what WOULD have been
  // charged), which is how full-price phantoms reached the things plane.
  it('skips orders Amazon marked Cancelled even when they still show an amount owed', async () => {
    const csv = [
      '"Order Date","Order ID","Product Name","Quantity","Total Owed","Currency","Unit Price","ASIN","Order Status"',
      '"2019-03-12","111-0000000-0000001","Logitech MK710","0","33.44","USD","33.44","B07LOGI001","Cancelled"',
      '"2011-08-06","111-0000000-0000002","Gift Card","0","90","USD","90","B07GIFT001","Cancelled"',
      // A cancelled line with a real quantity is still not a purchase.
      '"2020-01-01","111-0000000-0000003","Cancelled But Stocked","2","50.00","USD","25.00","B07CANC001","Cancelled"',
      '"2024-08-14","111-0000000-0000004","Real Purchase","1","12.00","USD","12.00","B07REAL001","Closed"',
      // An unfulfilled line inside an otherwise-closed order still drops.
      '"2023-12-06","111-0000000-0000005","Never Shipped","0","0","USD","12.78","B07NEVR001","Closed"',
    ].join('\n');
    const { items, drops } = await importCsv('__status__', csv);
    expect(items.map((i) => i.metadata.Product)).toEqual(['Real Purchase']);
    expect(drops).toEqual([
      ['cancelled_order', 'Logitech MK710'],
      ['cancelled_order', 'Gift Card'],
      ['cancelled_order', 'Cancelled But Stocked'],
      ['unfulfilled_line', 'Never Shipped'],
    ]);
  });

  // "Digital Content Orders.csv" is a ledger of monetary COMPONENTS (price, its
  // tax, a promotion, a coupon), each a signed Transaction Amount — one purchase
  // spans several rows. It sniffs as order history, and treating each row as a
  // line item produced one priceless item per component.
  it('collapses a digital component ledger into one purchase per line', async () => {
    const csv = [
      'ASIN,"Base Currency Code","Component Type","List Price Amount","Order Date","Order ID","Order Status",Price,"Product Name","Quantity Ordered","Transaction Amount"',
      '"B073XBG38V","USD","Price Amount","139.0","2026-01-10","D01-2718283-9024208","SUCCESS","139.0","Prime Membership Fee","1","139.0"',
      '"B073XBG38V","USD","Tax","139.0","2026-01-10","D01-2718283-9024208","SUCCESS","139.0","Prime Membership Fee","1","10.77"',
      // A promotional freebie: taken for 0.00 against a 1.99 list price.
      '"B00DIJQAI6","USD","Price Amount","1.99","2013-05-02","D01-4521202-2591303","SUCCESS","0.0","Sonic Racing","1","0.0"',
      '"B00DIJQAI6","USD","Price Amount","1.99","2013-05-02","D01-4521202-2591303","SUCCESS","0.0","Sonic Racing","1","0.0"',
      '"B00DIJQAI6","USD","Tax","1.99","2013-05-02","D01-4521202-2591303","SUCCESS","0.0","Sonic Racing","1","0.0"',
      // Amazon's own cancellation still drops.
      '"B0CANCEL01","USD","Price Amount","5.99","2020-01-01","D01-0000000-0000001","CANCELLED_BY_AMAZON","5.99","Cancelled Thing","1","5.99"',
    ].join('\n');
    const { items, drops } = await importCsv('__ledger__', csv);
    expect(items.length).toBe(2);
    expect(drops).toEqual([['cancelled_order', 'Cancelled Thing']]);

    const prime = items.find((i) => i.metadata.Product === 'Prime Membership Fee')!;
    expect(prime.metadata.Total).toBe('149.77'); // 139.00 price + 10.77 tax
    expect(prime.metadata['Unit Price']).toBe('139');
    expect(prime.metadata.Currency).toBe('USD');
    expect(prime.metadata.Quantity).toBe(1); // NOT summed across components
    expect(prime.metadata.Components).toBe(2);
    expect(prime.metadata['List Price']).toBeUndefined(); // same as price
    // The breakdown a receipt needs, read straight off the ledger's own
    // Component Type labels rather than inferred from Total - UnitPrice.
    expect(prime.metadata.Subtotal).toBe('139');
    expect(prime.metadata.Tax).toBe('10.77');

    const sonic = items.find((i) => i.metadata.Product === 'Sonic Racing')!;
    expect(sonic.metadata.Total).toBe('0');
    expect(sonic.metadata['List Price']).toBe('1.99'); // the promo is visible
    expect(sonic.metadata.Quantity).toBe(1);
    expect(sonic.metadata.Subtotal).toBe('0');
    expect(sonic.metadata.Tax).toBe('0');
  });

  it('leaves Subtotal/Tax unset when a ledger carries a component type this parser has never seen', async () => {
    // A hypothetical fourth component type (e.g. a future "Shipping" or
    // "Promotion" row Amazon has not been observed to emit here). Total must
    // still include it — Transaction Amount sums unconditionally — but
    // Subtotal/Tax must NOT silently absorb it under the wrong label.
    const csv = [
      'ASIN,"Base Currency Code","Component Type","Order Date","Order ID","Order Status",Price,"Product Name","Quantity Ordered","Transaction Amount"',
      '"B0UNKNOWN1","USD","Price Amount","2026-01-10","D01-9999999-0000001","SUCCESS","9.99","Mystery Item","1","9.99"',
      '"B0UNKNOWN1","USD","Restocking Fee","2026-01-10","D01-9999999-0000001","SUCCESS","9.99","Mystery Item","1","1.50"',
    ].join('\n');
    const { items } = await importCsv('__ledger_unknown__', csv);

    const mystery = items.find((i) => i.metadata.Product === 'Mystery Item')!;
    expect(mystery.metadata.Total).toBe('11.49'); // 9.99 + 1.50, unconditional
    expect(mystery.metadata.Subtotal).toBe('9.99'); // only the known Price Amount row
    expect(mystery.metadata.Tax).toBeUndefined(); // no Tax-typed row exists
  });

  // Nothing in a file Amazon named "Digital" is a physical object, so the rows
  // must declare themselves digital rather than leaving it to the mapping's
  // product-name guess (which reads "Prime Membership Fee" as a physical good).
  it('marks rows from any Digital-named file as digital', async () => {
    const row =
      '"2026-01-10","D01-2718283-9024208","Prime Membership Fee","1","149.77","USD","139.00","B073XBG38V"';
    const flag = async (name: string) =>
      (await importCsv(name, [HEADER, row].join('\n'))).items[0].metadata.Digital;

    expect(await flag('Digital Content Orders')).toBe(true);
    expect(await flag('Digital Items')).toBe(true);
    // Amazon runs the words together — a \b-anchored pattern would miss this.
    expect(await flag('Retail.DigitalSoftwareAndVideogames.Entitlements.1')).toBe(true);
    expect(await flag('digital-ordering')).toBe(true);

    // A normal order-history file leaves the flag off entirely.
    expect(await flag('__physical__')).toBeUndefined();
    expect(await flag('Retail.OrderHistory.1')).toBeUndefined();
  });

  // One 'order' item per order id — the purchase ACT, which maps to a single
  // timeline event (kind commerce.order → events) while the line items keep
  // their things/content homes. A five-item order is one event, not five.
  it('emits one order-level item per order, aggregated from its lines', async () => {
    const csv = [
      HEADER,
      '"2023-03-02T10:00:00Z","111-2233445-6677889","Widget","1","10.00","USD","10.00","B07ABC123"',
      '"2023-03-02T10:00:00Z","111-2233445-6677889","Gadget","2","25.50","USD","12.75","B07XYZ999"',
      '"2023-05-01","112-9988776-5544332","Solo Thing","1","5.00","USD","5.00","B07SOLO001"',
    ].join('\n');
    const { orders } = await importCsv('__orders__', csv);
    expect(orders.length).toBe(2);

    const multi = orders.find((o) => o.metadata['Order ID'] === '111-2233445-6677889')!;
    // Position-free, order-scoped id in its own namespace.
    expect(multi.id).toBe('amazon:order:111-2233445-6677889');
    expect(multi.classification).toBe('order');
    expect(multi.timestamp?.toISOString()).toBe('2023-03-02T10:00:00.000Z');
    expect(multi.metadata.Title).toBe('Amazon order — 2 items');
    expect(multi.metadata['Item Count']).toBe(2);
    expect(multi.metadata.Total).toBe('35.50'); // 10.00 + 25.50
    expect(multi.metadata.Currency).toBe('USD');
    // The product list rides in Description so the event is searchable.
    expect(multi.metadata.Description).toBe('Widget\nGadget');

    const solo = orders.find((o) => o.metadata['Order ID'] === '112-9988776-5544332')!;
    expect(solo.metadata.Title).toBe('Amazon order — 1 item');
    expect(solo.metadata.Total).toBe('5'); // money(): whole amounts render bare
  });

  it('itemises the order aggregate, so it is a receipt and not only an event', async () => {
    // A commerce.* record carrying LineItems routes to `receipts` as well as
    // `events` (push/canonical.ts destinationsFor). Without the itemisation the
    // order is a timeline entry that cannot say what was bought.
    const csv = [
      HEADER,
      '"2023-03-02T10:00:00Z","111-2233445-6677889","Widget","1","10.00","USD","10.00","B07ABC123"',
      '"2023-03-02T10:00:00Z","111-2233445-6677889","Gadget","2","25.50","USD","12.75","B07XYZ999"',
    ].join('\n');
    const { orders } = await importCsv('__lineitems__', csv);
    const lines = orders[0].metadata.LineItems as Array<Record<string, unknown>>;

    expect(orders[0].metadata.Merchant).toBe('Amazon');
    expect(lines).toHaveLength(2);
    // 1-based and STATED, not left to the array index: `(receipt_id,
    // line_number)` is a natural key, so a renumbering re-import forks lines.
    expect(lines.map((l) => l.LineNumber)).toEqual([1, 2]);
    expect(lines.map((l) => l.Product)).toEqual(['Widget', 'Gadget']);
    expect(lines[1]).toMatchObject({ Quantity: 2, 'Unit Price': '12.75', Total: '25.50' });
    expect(lines[0].Identifiers).toEqual([{ namespace: 'asin', value: 'B07ABC123' }]);
  });

  it('marks every line with the order receipt that already contains it', async () => {
    // Without the marker a five-item order produces five single-line receipts
    // ON TOP of the itemised one (push/canonical.ts `isRolledUp`).
    //
    // Driven through a MULTI-FILE export and a pipeline that behaves like
    // `staging/StagedWriter`: it splices a batch out at the flush threshold and
    // reads each item's metadata when it WRITES it, asynchronously. The order
    // aggregate spans every file in the export, so it can only be built after
    // the last one — by which time everything flushed during the earlier files
    // has already been written, and keeps whatever it said at that moment. A
    // plain array (which never flushes) cannot see the difference.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-amazon-rollup-'));
    const orderIds = ['111-2233445-6677889', '112-3344556-7788990', '113-4455667-8899001'];
    orderIds.forEach((oid, i) => {
      fs.writeFileSync(
        path.join(dir, `Retail.OrderHistory.${i + 1}.csv`),
        [
          HEADER,
          `"2023-03-02T10:00:00Z","${oid}","Widget","1","10.00","USD","10.00","B07ABC12${i}"`,
          `"2023-03-02T10:00:00Z","${oid}","Gadget","2","25.50","USD","12.75","B07XYZ99${i}"`,
        ].join('\n'),
      );
    });

    // Two lines per file, threshold two: every file's lines are written before
    // the next file is even read.
    const pipeline = new FlushingPipeline(2);
    try {
      await new AmazonFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      await pipeline.settled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const lines = pipeline.written.filter((w) => w.classification === 'purchase');
    const orders = pipeline.written.filter((w) => w.classification === 'order');

    expect(lines).toHaveLength(6);
    expect(orders).toHaveLength(3);
    // More than one batch was written mid-parse — otherwise this test proves
    // nothing that a plain array would not.
    expect(pipeline.flushes).toBeGreaterThan(1);

    // AS WRITTEN, not as left in memory afterwards. A line written with no
    // marker mints its own single-line receipt on top of the itemised one, so
    // an unmarked line here is a double-counted order.
    expect(lines.filter((l) => l.metadata.ReceiptRollupId == null)).toEqual([]);
    // And the marker must name the aggregate EXACTLY, or the line's receipt is
    // suppressed without the order receipt containing it.
    expect(new Set(lines.map((l) => l.metadata.ReceiptRollupId))).toEqual(new Set(orders.map((o) => o.id)));
  });

  it('namespaces an ISBN-10 in the ASIN column as an ISBN, not an ASIN', () => {
    // Amazon reuses ONE column for two namespaces (the header even says
    // `ASIN/ISBN`). An all-digit value the normalizer re-routes anyway, but an
    // ISBN-10 ending in X passes the ASIN grammar and would stick in the wrong
    // namespace — splitting one book into two objects forever.
    const csv = [
      HEADER,
      '"2023-03-02T10:00:00Z","111-0000000-0000009","A Book","1","10.00","USD","10.00","014028009X"',
    ].join('\n');

    return importCsv('__isbn__', csv).then(({ items }) => {
      expect(items[0].metadata.Identifiers).toEqual([{ namespace: 'isbn', value: '014028009X' }]);
      // The raw cell stays under its old flat key for existing readers.
      expect(items[0].metadata.ASIN).toBe('014028009X');
    });
  });

  // An order whose every line was dropped (cancelled) must not leave an event.
  it('emits no order item when all of its lines were dropped', async () => {
    const csv = [
      '"Order Date","Order ID","Product Name","Quantity","Total Owed","Currency","Unit Price","ASIN","Order Status"',
      '"2020-01-01","111-0000000-0000001","Cancelled Thing","1","10.00","USD","10.00","B07CANC001","Cancelled"',
      '"2021-01-01","111-0000000-0000002","Real Thing","1","8.00","USD","8.00","B07REAL001","Closed"',
    ].join('\n');
    const { orders } = await importCsv('__noorder__', csv);
    expect(orders.map((o) => o.metadata['Order ID'])).toEqual(['111-0000000-0000002']);
  });

  // Content rows have no time column in CI-Server, so the purchase date must
  // ride in metadata to reach source_data — without it a digital purchase
  // arrived with no date anywhere.
  it('restates the purchase date in metadata as Order Date', async () => {
    const csv = [
      HEADER,
      '"2023-01-15T10:30:00Z","111-2233445-6677889","Widget","1","10.00","USD","10.00","B07ABC123"',
    ].join('\n');
    const { items } = await importCsv('__odate__', csv);
    expect(items[0].metadata['Order Date']).toBe('2023-01-15T10:30:00.000Z');
  });

  // Digital purchases take their real media mimetype from the sidecar files a
  // full export ships beside the order CSVs: Digital.Content.Ownership states
  // a per-ASIN resourceType, the Appstore PDI entitlements name the apps, the
  // music library names the songs, and the Audible marketplace names the
  // audiobooks. What none of them claims is inferred to be a video purchase
  // (assumed mp4) unless its name says software/game-code/service or it has
  // no name at all. Subscription fees (per Digital Orders.csv's
  // SubscriptionOrderType) are services, not content — flagged so the mapping
  // routes them out of the content table.
  it('resolves digital mimetypes from the export sidecars and flags subscriptions', async () => {
    const fs = await import('node:fs');
    const dir = path.join(FIXTURES_DIR, '__amz_digital__');
    const ownershipRecord = (
      resourceType: string,
      asin: string,
      parent?: { resourceType: string; asin: string },
    ) =>
      JSON.stringify({
        rights: [{ rightType: 'Download', rightStatus: 'Active' }],
        resource: {
          resourceType,
          catalog: 'Amazon',
          ASIN: asin,
          'Product Name': 'Not Available',
          ...(parent
            ? { parent: { resourceType: parent.resourceType, catalog: 'Amazon', ASIN: parent.asin } }
            : {}),
        },
        entity: { entityType: 'Customer' },
      });
    const itemsHeader =
      'ASIN,ProductName,OrderId,Marketplace,OrderDate,OriginalQuantity,OurPrice,OurPriceCurrencyCode';
    const itemRow = (asin: string, name: string, oid: string, marketplace = 'www.amazon.com') =>
      `"${asin}","${name}","${oid}","${marketplace}","2024-01-15T10:00:00Z","1","9.99","USD"`;

    await fs.promises.mkdir(path.join(dir, 'Digital-Ordering.1'), { recursive: true });
    await fs.promises.mkdir(path.join(dir, 'Digital.Content.Ownership'), { recursive: true });
    await fs.promises.mkdir(path.join(dir, 'Appstore.Entitlements', 'datasets', 'PDI'), { recursive: true });
    await fs.promises.mkdir(path.join(dir, 'Your Music Library'), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, 'Digital-Ordering.1', 'Digital Items.csv'),
      [
        itemsHeader,
        itemRow('B0EBOOK0001', 'The Hobbit (Kindle Edition)', 'D01-0000001-0000001'),
        itemRow('B0MUSIC0001', 'Have a Cigar', 'D01-0000002-0000002'),
        itemRow('B0MUSALB001', 'Wish You Were Here (Album)', 'D01-0000003-0000003'),
        itemRow('B0APP000001', 'Some App', 'D01-0000004-0000004'),
        itemRow('B0APP000002', 'Other App', 'D01-0000005-0000005'),
        itemRow('B0AUDIBLE01', 'Guards! Guards!', 'D01-0000006-0000006', 'www.audible.com'),
        itemRow('B0LIBSONG01', "Don't Get Excited (Acoustic)", 'D01-0000010-0000010'),
        itemRow('B0VIDEO0001', 'The Dark Knight', 'D01-0000007-0000007'),
        itemRow('B0MYSTERY01', 'TurboTax Premier 2024 Tax Software', 'D01-0000008-0000008'),
        itemRow('B0GAMECD001', "Assassin's Creed - Story Pass - PS4 [Digital Code]", 'D01-0000011-0000011'),
        itemRow('B0NONAME001', 'Not Applicable', 'D01-0000012-0000012'),
        itemRow('B073XBG38V', 'Prime Membership Fee', 'D01-0000009-0000009'),
        // Subscription-named but ABSENT from Digital Orders.csv — the name
        // backstop must keep it out of the video fallback anyway.
        itemRow('B0MUSICSUB1', 'Amazon Music Unlimited Subscription', 'D01-0000013-0000013'),
      ].join('\n'),
    );
    await fs.promises.writeFile(
      path.join(dir, 'Digital-Ordering.1', 'Digital Orders.csv'),
      [
        'OrderId,OrderStatus,Marketplace,SubscriptionOrderType',
        'D01-0000009-0000009,SUCCESS,www.amazon.com,Subscription_Renewal',
        'D01-0000001-0000001,SUCCESS,www.amazon.com,Not Applicable',
      ].join('\n'),
    );
    await fs.promises.writeFile(
      path.join(dir, 'Digital.Content.Ownership', 'Digital.Content.Ownership.1.json'),
      ownershipRecord('KindleEBook', 'B0EBOOK0001'),
    );
    await fs.promises.writeFile(
      path.join(dir, 'Digital.Content.Ownership', 'Digital.Content.Ownership.2.json'),
      // The album ASIN is only stated as the track's PARENT resource.
      ownershipRecord('DigitalMusicTrack', 'B0MUSIC0001', {
        resourceType: 'DigitalMusic',
        asin: 'B0MUSALB001',
      }),
    );
    await fs.promises.writeFile(
      path.join(dir, 'Digital.Content.Ownership', 'Digital.Content.Ownership.3.json'),
      ownershipRecord('MobileApp', 'B0APP000001'),
    );
    await fs.promises.writeFile(
      path.join(dir, 'Appstore.Entitlements', 'datasets', 'PDI', 'PDI.csv'),
      [
        'ASIN,"Product Name","Entitlement Date",Source,Type,Status',
        'B0APP000002,"Other App",2020-01-01T00:00:00Z,PURCHASE,App,ACTIVE',
      ].join('\n'),
    );
    await fs.promises.writeFile(
      path.join(dir, 'Your Music Library', 'Saved Music.csv'),
      [
        'ASIN,"Album ASIN","Artist Name","File Extension",Title',
        `B0LIBSONG01,B0LIBALB001,"Jenny Owen Youngs",m4a,"Don't Get Excited (Acoustic)"`,
      ].join('\n'),
    );

    try {
      const pipeline: EmittedGraph[] = [];
      await new AmazonFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      const purchases = pipeline.map((g) => g.item).filter((i) => i.classification === 'purchase');
      const mimeOf = (asin: string) => purchases.find((i) => i.metadata.ASIN === asin)!.content.mediaType;

      expect(mimeOf('B0EBOOK0001')).toBe('application/vnd.amazon.ebook'); // ownership: KindleEBook
      expect(mimeOf('B0MUSIC0001')).toBe('audio/mpeg'); // ownership: DigitalMusicTrack
      expect(mimeOf('B0MUSALB001')).toBe('audio/mpeg'); // ownership: parent DigitalMusic
      expect(mimeOf('B0APP000001')).toBe('application/vnd.android.package-archive'); // ownership: MobileApp
      expect(mimeOf('B0APP000002')).toBe('application/vnd.android.package-archive'); // Appstore PDI
      expect(mimeOf('B0AUDIBLE01')).toBe('audio/vnd.audible.aax'); // Audible marketplace
      expect(mimeOf('B0LIBSONG01')).toBe('audio/mp4'); // music library, m4a extension
      // Claimed by no sidecar: a retail digital purchase is inferred video —
      // never-streamed titles included.
      expect(mimeOf('B0VIDEO0001')).toBe('video/mp4');
      // The named exceptions to that inference carry NO mimetype — better no
      // claim than a wrong one.
      expect(mimeOf('B0MYSTERY01')).toBeUndefined(); // "… Tax Software"
      expect(mimeOf('B0GAMECD001')).toBeUndefined(); // "… [Digital Code]"
      expect(mimeOf('B0MUSICSUB1')).toBeUndefined(); // service-named, join-less
      // A name Amazon redacted to "Not Applicable" describes nothing — the
      // whole line is dropped, not imported untyped.
      expect(purchases.find((i) => i.metadata.ASIN === 'B0NONAME001')).toBeUndefined();

      // The subscription line: no mimetype, flagged for the mapping to skip.
      const sub = purchases.find((i) => i.metadata.ASIN === 'B073XBG38V')!;
      expect(sub.content.mediaType).toBeUndefined();
      expect(sub.metadata.Subscription).toBe(true);
      // Everything else stays unflagged.
      expect(purchases.filter((i) => i.metadata.Subscription).length).toBe(1);
      // Its purchase EVENT survives: the per-order aggregate still carries it.
      const orders = pipeline.map((g) => g.item).filter((i) => i.classification === 'order');
      expect(orders.some((o) => o.metadata.Description === 'Prime Membership Fee')).toBe(true);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  // The component-ledger dialect ("Your Orders" exports) carries the
  // subscription fact on its own rows — no sibling join available or needed.
  it('flags ledger subscription lines from their own Subscription Order Type column', async () => {
    const csv = [
      '"Order Date","Order ID","Product Name",ASIN,"Component Type","Transaction Amount","Price","Base Currency Code","Quantity Ordered","Subscription Order Type"',
      '"2024-08-09T20:55:00Z","D01-2718283-9024208","Prime Membership Fee","B073XBG38V","Price Amount","139.0","139.0","USD","1","Subscription_Renewal"',
      '"2024-08-09T20:55:00Z","D01-2718283-9024208","Prime Membership Fee","B073XBG38V","Tax","10.77","139.0","USD","1","Subscription_Renewal"',
      '"2024-09-01T10:00:00Z","D01-1111111-2222222","Stardew Valley","B01BLAH001","Price Amount","4.99","4.99","USD","1","Not Applicable"',
    ].join('\n');
    const { items } = await importCsv('Digital Content Orders', csv);
    const prime = items.find((i) => i.metadata.Product === 'Prime Membership Fee')!;
    expect(prime.metadata.Subscription).toBe(true);
    expect(prime.metadata.Total).toBe('149.77'); // components still sum for the order event
    const game = items.find((i) => i.metadata.Product === 'Stardew Valley')!;
    expect(game.metadata.Subscription).toBeUndefined();
  });

  it('does not throw on an empty file', async () => {
    const fs = await import('node:fs');
    const tmp = path.join(FIXTURES_DIR, 'amazon-export', '__empty__.csv');
    await fs.promises.writeFile(tmp, '');
    try {
      const fi = new AmazonFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: '__empty__.csv', fullPath: tmp }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });
});

/*
 * The money breakdown, against the REAL "Your Orders" export header.
 *
 * `fixtures/amazon-your-orders/Order History.csv` is thirteen rows lifted
 * verbatim out of a live 2,064-row export — all 28 columns in Amazon's own
 * order, every amount, quantity, ASIN and product name untouched (only the
 * address and cardholder columns are replaced, and nothing reads those). The
 * rows were chosen because each one pins a different way the breakdown went
 * wrong:
 *
 *   111-1329443-6205810  the reported defect: 71.85 + 5.57 tax = 77.42 charged,
 *                        stored as a LINE total of 77.42
 *   111-8079083-2877059  quantity 3 — proves `Unit Price Tax` is PER UNIT
 *   111-4820738-6806659  three lines in ONE shipment, all three carrying
 *                        `Shipment Item Subtotal` 86.77 — which is their SUM
 *   116-7013204-3369844  a non-zero `Shipping Charge`
 *   114-2826989-5545831  a discount, written `'-89'` — Excel text quoting
 *   112-1742533-6120260  "11,437.78" — a thousands separator inside the cell
 *   112-0129751-0345803  an order that genuinely does NOT reconcile ($7.00
 *                        unexplained by any column — a state recycling fee)
 *   113-4686340-8106606  two rows, same ASIN, same product name — a
 *                        weight-priced grocery item Amazon split into two
 *                        differently-priced physical units (0.55 and 0.25)
 *   114-6974509-5422626  two rows, same ASIN, SAME price (16.99) — the
 *                        ordinary multi-shipment split (qty 2 then 3) that
 *                        113-4686340-8106606 above is the exception to
 */
describe('Amazon money breakdown (real "Your Orders" export header)', () => {
  const ROOT = path.join(FIXTURES_DIR, 'amazon-your-orders');

  /** Import the fixture, returning everything emitted plus the warnings logged. */
  async function runFixture(): Promise<{ pipeline: EmittedGraph[]; warnings: string[] }> {
    const fi = new AmazonFileImporter();
    const pipeline: EmittedGraph[] = [];
    const warnings: string[] = [];
    await fi.fileImport({}, { filename: 'amazon-your-orders', fullPath: ROOT }, {
      pipeline,
      timeframe: {},
      log: (level: string, msg: string) => {
        if (level === 'warn') {
          warnings.push(msg);
        }
      },
    } as unknown as ImportParams);

    return { pipeline, warnings };
  }

  /** The order-level aggregate for an order id — the record that becomes the receipt. */
  function orderFor(pipeline: EmittedGraph[], orderId: string): EmittedItem {
    const found = pipeline.find(
      (g) => g.item.classification === 'order' && g.item.metadata['Order ID'] === orderId,
    );
    expect(found).toBeDefined();

    return found!.item;
  }

  /** The line items itemised on an order aggregate. */
  function linesOf(order: EmittedItem): LineItemRecord[] {
    return (order.metadata.LineItems ?? []) as LineItemRecord[];
  }

  it("gives a line its OWN total, not the order's", async () => {
    const { pipeline } = await runFixture();
    const [line] = linesOf(orderFor(pipeline, '111-1329443-6205810'));

    // 71.85 + 5.57 tax = 77.42 charged. The line is worth 71.85; 77.42 is the
    // order's, and storing it on the line is what made every single-line order
    // "reconcile" 630/630 against a copy of its own total.
    expect(line['Unit Price']).toBe('71.85');
    expect(line.Subtotal).toBe('71.85');
    expect(line.Tax).toBe('5.57');
    expect(line.Total).toBe('77.42');
  });

  it('scales tax by quantity — Unit Price Tax is per UNIT', async () => {
    const { pipeline } = await runFixture();
    const order = orderFor(pipeline, '111-8079083-2877059');

    // 3 × 34.95 = 104.85 subtotal, 3 × 2.71 = 8.13 tax, 112.98 charged.
    // Reading `Unit Price Tax` as the line's tax would understate it by 5.42.
    expect(order.metadata.Subtotal).toBe('104.85');
    expect(order.metadata.Tax).toBe('8.13');
    expect(order.metadata.Total).toBe('112.98');
  });

  it('never mistakes the SHIPMENT subtotal for a line subtotal', async () => {
    const { pipeline } = await runFixture();
    const order = orderFor(pipeline, '111-4820738-6806659');
    const lines = linesOf(order);

    // Every one of these three rows carries `Shipment Item Subtotal` = 86.77
    // and `Shipment Item Subtotal Tax` = 6.72 — the SHIPMENT's, not the line's.
    // Trusting that column would bill each line 86.77 and the order 260.31.
    expect(lines.map((l) => l.Subtotal)).toEqual(['22.89', '39.99', '23.89']);
    expect(order.metadata.Subtotal).toBe('86.77');
    expect(order.metadata.Tax).toBe('6.72');
    expect(order.metadata.Total).toBe('93.49');
  });

  it('carries the shipping charge into the breakdown', async () => {
    const { pipeline } = await runFixture();
    const order = orderFor(pipeline, '116-7013204-3369844');

    expect(order.metadata.Subtotal).toBe('412');
    expect(order.metadata.Shipping).toBe('6.99');
    expect(order.metadata.Total).toBe('418.99');
  });

  it('averages the unit price when a merged line disagrees with itself, rather than dropping a row', async () => {
    const { pipeline } = await runFixture();
    const [line] = linesOf(orderFor(pipeline, '113-4686340-8106606'));

    // Two real "PRODUCE Organic Shallots" rows, same ASIN, priced 0.55 and
    // 0.25 — two separately-weighed units, not one item counted twice.
    // Quantity sums to 2 (correct); a naive "first row's price" would report
    // Unit Price 0.55 and silently lose the second unit's real 0.25 cost.
    // 0.80 / 2 = 0.40 is the honest average, and it is what makes the line's
    // own arithmetic (quantity * unitPrice = total) hold.
    expect(line.Quantity).toBe(2);
    expect(line.Total).toBe('0.80');
    expect(line['Unit Price']).toBe('0.40');
  });

  it('leaves a single-priced merged line untouched — the common multi-shipment case', async () => {
    const { pipeline } = await runFixture();
    // 114-6974509-5422626: one ASIN, one real order, split across TWO
    // shipments (qty 2 then qty 3) — Amazon's ordinary multi-shipment case,
    // and both rows genuinely agree on Unit Price (16.99). mergedUnitPrice
    // must return primary's raw string here, not a derived average that
    // happens to land on the same number — the two are only guaranteed to
    // coincide because this particular order has no tax-rounding remainder.
    const [line] = linesOf(orderFor(pipeline, '114-6974509-5422626'));

    expect(line.Quantity).toBe(5); // 2 + 3
    expect(line['Unit Price']).toBe('16.99');
    // 5 * 16.99 = 84.95 — primary's raw price, not an average, still reconciles.
    expect(line.Subtotal).toBe('84.95');
  });

  it("reads Amazon's Excel-quoted negative discount as a positive magnitude", async () => {
    const { pipeline } = await runFixture();
    const order = orderFor(pipeline, '114-2826989-5545831');

    // The cell holds the literal characters `'-89'`. `Number()` says NaN, which
    // is why no discount had ever reached a receipt; and the sign has to flip,
    // because `discount_minor` is the amount taken OFF (subtotal + tax +
    // shipping − discount = total) and a cost column refuses a negative.
    expect(order.metadata.Discount).toBe('89');
    expect(order.metadata.Subtotal).toBe('229.99');
    expect(order.metadata.Total).toBe('140.99');
  });

  it('sums a total written with a thousands separator', async () => {
    const { pipeline } = await runFixture();
    const order = orderFor(pipeline, '112-1742533-6120260');

    // "11,437.78" is NaN to `Number()`, so this order reached the spend chart
    // with no `Amount` at all — eleven such orders, ~$34k, in one real export.
    expect(order.metadata.Total).toBe('11437.78');
    expect(order.metadata.Amount).toBe('11437.78');
    expect(order.metadata.Subtotal).toBe('10615.11');
    expect(order.metadata.Tax).toBe('822.67');
  });

  it('reports an order whose parts do not add up, and still writes the parts', async () => {
    const { pipeline, warnings } = await runFixture();
    const order = orderFor(pipeline, '112-0129751-0345803');

    // 329.99 + 25.57 = 355.56, but 362.56 was charged: $7.00 this export does
    // not explain in any column. The numbers are Amazon's own, so they are
    // still written — what must not happen is writing them silently.
    expect(order.metadata.Subtotal).toBe('329.99');
    expect(order.metadata.Tax).toBe('25.57');
    expect(order.metadata.TotalsMismatchNote).toContain('362.56 was charged');
    expect(warnings.filter((w) => w.includes('112-0129751-0345803'))).toHaveLength(1);
  });

  it('reports nothing for the orders that do reconcile', async () => {
    const { pipeline, warnings } = await runFixture();
    const reconciling = ['111-1329443-6205810', '111-8079083-2877059', '111-4820738-6806659'];

    for (const oid of reconciling) {
      expect(orderFor(pipeline, oid).metadata.TotalsMismatchNote).toBeUndefined();
      expect(warnings.filter((w) => w.includes(oid))).toHaveLength(0);
    }
  });

  it('reads a product name containing commas without shifting the columns', async () => {
    const { pipeline } = await runFixture();
    const order = orderFor(pipeline, '111-8079083-2877059');
    const [line] = linesOf(order);

    // "Noctua NF-A12x25 PWM, Premium Quiet Fan, 4-Pin (120mm, Brown)" holds
    // four commas inside its quotes, and `Product Name` sits in the MIDDLE of
    // the 28 columns — a naive split would shift every money column after it by
    // four places and read the ship date as a price. This is the assertion that
    // says the parser is a real CSV reader (datasources/csv.ts → csv-parse).
    expect(line.Product).toBe('Noctua NF-A12x25 PWM, Premium Quiet Fan, 4-Pin (120mm, Brown)');
    expect(line['Unit Price']).toBe('34.95');
    expect(line.Quantity).toBe(3);
    expect(order.metadata.Currency).toBe('USD');
  });
});
