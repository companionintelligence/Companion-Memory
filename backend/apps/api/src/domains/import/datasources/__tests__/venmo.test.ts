import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import type { ImportParams } from '../timeline';
import { VenmoFileImporter } from '../venmo';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Venmo datasource', () => {
  it('recognizes export directory by the statement CSV header', async () => {
    const root = path.join(FIXTURES_DIR, 'venmo-export');
    const fi = new VenmoFileImporter();
    const rec = await fi.recognize({}, { filename: 'venmo-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a single statement CSV file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'venmo-export', 'venmo_statement.csv');
    const fi = new VenmoFileImporter();
    const rec = await fi.recognize({}, { filename: 'venmo_statement.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('does not recognize an unrelated CSV', async () => {
    const tmp = path.join(os.tmpdir(), `not-venmo-${Date.now()}.csv`);
    await fs.promises.writeFile(tmp, 'foo,bar,baz\n1,2,3\n');
    try {
      const fi = new VenmoFileImporter();
      const rec = await fi.recognize({}, { filename: path.basename(tmp), fullPath: tmp });
      expect(rec.confidence).toBe(0);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });

  it('imports real transaction rows and skips summary/balance rows', async () => {
    const root = path.join(FIXTURES_DIR, 'venmo-export');
    const fi = new VenmoFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'venmo-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 3 real transactions; the empty-ID running-balance & summary rows are skipped.
    expect(pipeline.length).toBe(3);

    const first = pipeline[0].item;
    // Outgoing Payment (negative amount) → 'payment' (the commerce.payment kind).
    expect(first.classification).toBe('payment');
    // Pure money movement: no content is attached, everything rides in metadata.
    expect(first.content).toBeUndefined();
    // Note and amount join with a colon; the sign collapses onto the amount.
    expect(first.metadata.Title).toBe('Dinner split: -$24.50');
    expect(first.metadata.Type).toBe('Payment');
    expect(first.metadata.Status).toBe('Complete');
    expect(first.metadata.Note).toBe('Dinner split');
    expect(first.metadata.From).toBe('Jane Doe');
    expect(first.metadata.To).toBe('John Smith');
    expect(first.metadata.Amount).toBe('-$24.50');
    expect(first.metadata['Transaction ID']).toBe('3201234567890123456');
    expect(first.timestamp).toBeInstanceOf(Date);
    expect(first.timestamp!.getTime()).toBe(new Date('2023-01-15T10:30:00').getTime());

    // Outgoing Payment links the To name as a person entity.
    expect(pipeline[0].edges).toEqual([
      { relation: 'to', to: { entity: { type: 'person', name: 'John Smith' } } },
    ]);

    // Quoted field with an embedded comma is preserved.
    expect(pipeline[1].item.metadata.Note).toBe('Concert tickets, row 5');
    expect(pipeline[1].item.metadata.Amount).toBe('+$120.00');
    // A Charge Jane sent Alex that he paid: money in, from the person charged.
    expect(pipeline[1].item.classification).toBe('credit');
    expect(pipeline[1].edges).toEqual([
      { relation: 'from', to: { entity: { type: 'person', name: 'Alex Kim' } } },
    ]);

    // Quoted field with an embedded newline is preserved.
    expect(pipeline[2].item.metadata.Note).toBe('Rent\nMarch');
    expect(pipeline[2].item.metadata.Amount).toBe('-$850.00');
    expect(pipeline[2].item.classification).toBe('payment');
    expect(pipeline[2].edges).toEqual([
      { relation: 'to', to: { entity: { type: 'person', name: 'Maria Lopez' } } },
    ]);
  });

  it('maps Type × amount sign to commerce classifications and counterparty entities', async () => {
    const header = ',ID,Datetime,Type,Status,Note,From,To,Amount (total)\n';
    const csv =
      'Account Statement - (@jane-doe)\nAccount Activity\n' +
      header +
      ',3201,2023-01-15T10:30:00,Payment,Complete,Out,Jane Doe,John Smith,- $10.00\n' +
      ',3202,2023-01-16T10:30:00,Payment,Complete,In,Alex Kim,Jane Doe,+ $20.00\n' +
      ',3203,2023-01-17T10:30:00,Standard Transfer,Issued,,,,- $30.00\n' +
      ',3204,2023-01-18T10:30:00,Card Payment,Complete,,Card Payment,Jane Doe,+ $40.00\n';
    const tmp = path.join(os.tmpdir(), `types-venmo-${Date.now()}.csv`);
    await fs.promises.writeFile(tmp, csv);
    try {
      const fi = new VenmoFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: path.basename(tmp), fullPath: tmp }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.map((g) => g.item.classification)).toEqual(['payment', 'credit', 'transfer', 'credit']);
      // Incoming Payment links the From name; transfers and card payments link no one.
      expect(pipeline[1].edges).toEqual([
        { relation: 'from', to: { entity: { type: 'person', name: 'Alex Kim' } } },
      ]);
      expect(pipeline[2].edges).toBeUndefined();
      expect(pipeline[3].edges).toBeUndefined();
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });

  it('maps Charges by who sent the request and keeps the fee on an Instant Transfer', async () => {
    const header =
      ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Funding Source,Destination\n';
    const csv =
      'Account Statement - (@jane-doe)\nAccount Activity\n' +
      header +
      ',4101,2026-04-21T23:02:18,Charge,Complete,utilities April,Sam Reyes,Jane Doe,- $63.12,,0,,Bank *2291,\n' +
      ',4102,2026-06-03T12:30:55,Charge,Complete,concert tickets,Jane Doe,Lee Park,+ $45.00,,0,,,Venmo balance\n' +
      ',4103,2026-09-27T15:51:33,Instant Transfer,Complete,,,,- $50.00,,0,- $0.88,,Bank *2291\n';
    const tmp = path.join(os.tmpdir(), `charges-venmo-${Date.now()}.csv`);
    await fs.promises.writeFile(tmp, csv);
    try {
      const fi = new VenmoFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: path.basename(tmp), fullPath: tmp }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.map((g) => g.item.classification)).toEqual(['payment', 'credit', 'transfer']);

      // Sam charged Jane and she paid: money out to the person who asked, with
      // a receipt line like any outgoing payment.
      const [paid, received, transfer] = pipeline;
      expect(paid.edges).toEqual([{ relation: 'to', to: { entity: { type: 'person', name: 'Sam Reyes' } } }]);
      expect(paid.item.metadata.Merchant).toBe('Sam Reyes');
      expect(paid.item.metadata.LineItems).toEqual([
        { LineNumber: 1, Product: 'utilities April', Quantity: 1, Total: 63.12, IsDigital: undefined },
      ]);

      // Jane charged Lee and he paid: money in from the person charged.
      expect(received.edges).toEqual([
        { relation: 'from', to: { entity: { type: 'person', name: 'Lee Park' } } },
      ]);
      expect(received.item.metadata.LineItems).toBeUndefined();

      expect(transfer.edges).toBeUndefined();
      expect(transfer.item.metadata.Amount).toBe('-$50.00');
      expect(transfer.item.metadata.Fee).toBe('-$0.88');
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });

  it('respects the timeframe filter', async () => {
    const root = path.join(FIXTURES_DIR, 'venmo-export');
    const fi = new VenmoFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'venmo-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2023-02-01T00:00:00'), until: new Date('2023-03-01T00:00:00') },
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata['Transaction ID']).toBe('3209876543210987654');
  });

  it('assigns unique, stable, idempotent ids to transactions that would otherwise collapse', async () => {
    // Two transactions at the SAME Datetime second with the constant
    // 'transaction.txt' filename would collapse under the content-hash dedup
    // key unless a per-transaction id is set.
    const header =
      ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (fee),Funding Source,Destination\n';
    const csv =
      'Account Statement - (@jane-doe)\nAccount Activity\n' +
      header +
      ',3201111111111111111,2023-01-15T10:30:00,Payment,Complete,A,Jane Doe,John Smith,- $1.00,,,Venmo balance,\n' +
      ',3202222222222222222,2023-01-15T10:30:00,Payment,Complete,B,Jane Doe,John Smith,- $2.00,,,Venmo balance,\n';
    const tmp = path.join(os.tmpdir(), `collapse-venmo-${Date.now()}.csv`);
    await fs.promises.writeFile(tmp, csv);
    try {
      const fi = new VenmoFileImporter();
      const importOnce = async () => {
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: path.basename(tmp), fullPath: tmp }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        return pipeline;
      };

      const pipeline = await importOnce();
      expect(pipeline.length).toBe(2);
      const ids = pipeline.map((g) => g.item.id!);
      expect(ids.every((id) => !!id)).toBe(true); // every id truthy
      expect(new Set(ids).size).toBe(ids.length); // all ids unique

      // Re-import yields identical ids (idempotent).
      const pipeline2 = await importOnce();
      expect(pipeline2.map((g) => g.item.id!)).toEqual(ids);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });

  it('does not throw on an empty file', async () => {
    const tmp = path.join(os.tmpdir(), `empty-venmo-${Date.now()}.csv`);
    await fs.promises.writeFile(tmp, '');
    try {
      const fi = new VenmoFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: path.basename(tmp), fullPath: tmp }, {
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
