import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { RobinhoodFileImporter } from '../robinhood';
import type { ImportParams } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';

// The real header + two real example rows, quoted verbatim from the cited
// source's raw file (fetched directly from raw.githubusercontent.com, not the
// rendered page):
// https://github.com/GrantBirki/ghostfolio/blob/main/docs/imports/robinhood.md
//
//   "Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"
//   "9/18/2023","9/18/2023","9/20/2023","O","Realty Income
//   CUSIP: 756109104
//   Dividend Reinvestment","Buy","0.810399","$53.85","($43.64)"
//   "9/15/2023","9/15/2023","9/15/2023","O","Cash Div: R/D 2023-09-01 P/D 2023-09-15 - 170.816188 shares at 0.2555","CDIV","","","$43.64"
//   "9/15/2023","9/15/2023","9/19/2023","MSFT","Microsoft
//   CUSIP: 594918104
//   Dividend Reinvestment","Buy","0.060732","$333.76","($20.27)"
//   "9/14/2023","9/14/2023","9/14/2023","MSFT","Cash Div: R/D 2023-08-17 P/D 2023-09-14 - 29.813147 shares at 0.68","CDIV","","","$20.27"
const REAL_HEADER =
  '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"';
const REAL_CSV =
  REAL_HEADER +
  '\n' +
  '"9/18/2023","9/18/2023","9/20/2023","O","Realty Income\nCUSIP: 756109104\nDividend Reinvestment","Buy","0.810399","$53.85","($43.64)"\n' +
  '"9/15/2023","9/15/2023","9/15/2023","O","Cash Div: R/D 2023-09-01 P/D 2023-09-15 - 170.816188 shares at 0.2555","CDIV","","","$43.64"\n' +
  '"9/15/2023","9/15/2023","9/19/2023","MSFT","Microsoft\nCUSIP: 594918104\nDividend Reinvestment","Buy","0.060732","$333.76","($20.27)"\n' +
  '"9/14/2023","9/14/2023","9/14/2023","MSFT","Cash Div: R/D 2023-08-17 P/D 2023-09-14 - 29.813147 shares at 0.68","CDIV","","","$20.27"\n';

async function runImport(csv: string, pipeline: EmittedGraph[] = []): Promise<EmittedGraph[]> {
  const tmp = path.join(os.tmpdir(), `robinhood-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  await fs.promises.writeFile(tmp, csv);
  try {
    const fi = new RobinhoodFileImporter();
    await fi.fileImport({}, { filename: path.basename(tmp), fullPath: tmp }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

describe('Robinhood recognize()', () => {
  async function withTempFile(
    name: string,
    content: string,
    fn: (fpath: string) => Promise<void>,
  ): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-recognize-'));
    const fpath = path.join(dir, name);
    await fs.promises.writeFile(fpath, content);
    try {
      await fn(fpath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('gives high confidence when the header carries all three signature columns', async () => {
    await withTempFile('robinhood_transactions.csv', REAL_CSV, async (fpath) => {
      const fi = new RobinhoodFileImporter();
      const rec = await fi.recognize({}, { filename: path.basename(fpath), fullPath: fpath });
      expect(rec.confidence).toBe(0.9);
    });
  });

  it('gives zero confidence to a same-named CSV with unrelated content', async () => {
    // "transactions.csv" is a generic name any bank or broker's own CSV
    // download could produce — the header check is what actually matters.
    const unrelated = 'Date,Description,Amount\n01/01/2024,Coffee,-4.50\n';
    await withTempFile('transactions.csv', unrelated, async (fpath) => {
      const fi = new RobinhoodFileImporter();
      const rec = await fi.recognize({}, { filename: 'transactions.csv', fullPath: fpath });
      expect(rec.confidence).toBe(0);
    });
  });

  it('gives zero confidence to a CSV with Trans Code but no Instrument column', async () => {
    // Close, but missing one of the three signature columns — must not match
    // on a partial header.
    const partial = '"Activity Date","Trans Code","Amount"\n"9/18/2023","Buy","($43.64)"\n';
    await withTempFile('close_but_no_instrument.csv', partial, async (fpath) => {
      const fi = new RobinhoodFileImporter();
      const rec = await fi.recognize({}, { filename: path.basename(fpath), fullPath: fpath });
      expect(rec.confidence).toBe(0);
    });
  });

  it('gives zero confidence to a non-.csv file even with a matching header', async () => {
    await withTempFile('export.txt', REAL_CSV, async (fpath) => {
      const fi = new RobinhoodFileImporter();
      const rec = await fi.recognize({}, { filename: 'export.txt', fullPath: fpath });
      expect(rec.confidence).toBe(0);
    });
  });

  it('recognizes a directory by scanning its CSVs for a matching header', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-recognize-dir-'));
    try {
      await fs.promises.writeFile(path.join(dir, 'unrelated.csv'), 'Date,Amount\n01/01/2024,5.00\n');
      await fs.promises.writeFile(path.join(dir, 'robinhood.csv'), REAL_CSV);
      const fi = new RobinhoodFileImporter();
      const rec = await fi.recognize({}, { filename: path.basename(dir), fullPath: dir });
      expect(rec.confidence).toBe(0.9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives a directory with no matching CSV a low dir_threshold instead of a false match', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-recognize-dir-'));
    try {
      await fs.promises.writeFile(path.join(dir, 'unrelated.csv'), 'Date,Amount\n01/01/2024,5.00\n');
      const fi = new RobinhoodFileImporter();
      const rec = await fi.recognize({}, { filename: path.basename(dir), fullPath: dir });
      expect(rec.confidence).toBe(0);
      expect(rec.dir_threshold).toBe(0.7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Robinhood import — the real cited fixture', () => {
  it('imports both dividend-reinvestment Buys and both cash CDIVs', async () => {
    const pipeline = await runImport(REAL_CSV);
    expect(pipeline.length).toBe(4);

    const byCode = pipeline.map((p) => [p.item.metadata['Trans Code'], p.item.metadata.Instrument]);
    expect(byCode).toEqual([
      ['Buy', 'O'],
      ['CDIV', 'O'],
      ['Buy', 'MSFT'],
      ['CDIV', 'MSFT'],
    ]);
  });

  it('classifies a dividend-reinvestment Buy as payment and a CDIV as credit', async () => {
    const pipeline = await runImport(REAL_CSV);
    expect(pipeline[0].item.classification).toBe('payment');
    expect(pipeline[1].item.classification).toBe('credit');
  });

  it('parses the accounting-parentheses Amount and the $-prefixed Price as raw strings, untouched', async () => {
    const pipeline = await runImport(REAL_CSV);
    const buy = pipeline[0].item.metadata;
    expect(buy.Amount).toBe('($43.64)');
    expect(buy.Price).toBe('$53.85');
    expect(buy.Quantity).toBe('0.810399');
  });

  it('leaves Quantity/Price ABSENT (not "0") on a CDIV row that carries neither', async () => {
    const pipeline = await runImport(REAL_CSV);
    const cdiv = pipeline[1].item.metadata;
    expect(cdiv.Quantity).toBeUndefined();
    expect(cdiv.Price).toBeUndefined();
    expect(cdiv.Amount).toBe('$43.64');
  });

  it('collapses a multi-line Description into a one-line Title, and keeps Description verbatim (with its newlines)', async () => {
    const pipeline = await runImport(REAL_CSV);
    const buy = pipeline[0].item.metadata;
    expect(buy.Title).toBe('Realty Income — CUSIP: 756109104 — Dividend Reinvestment');
    expect(buy.Description).toBe('Realty Income\nCUSIP: 756109104\nDividend Reinvestment');
  });

  it('parses Activity Date as the item timestamp', async () => {
    const pipeline = await runImport(REAL_CSV);
    const ts = pipeline[0].item.timestamp;
    expect(ts).toBeInstanceOf(Date);
    expect(ts?.getFullYear()).toBe(2023);
    expect(ts?.getMonth()).toBe(8); // September, 0-indexed
    expect(ts?.getDate()).toBe(18);
  });

  it('creates event-only items with no content payload', async () => {
    const pipeline = await runImport(REAL_CSV);
    for (const p of pipeline) {
      expect(p.item.content).toBeUndefined();
    }
  });

  it('assigns stable, unique, idempotent ids even though Robinhood issues no per-row transaction id', async () => {
    const first = await runImport(REAL_CSV);
    const ids = first.map((p) => p.item.id!);
    for (const id of ids) {
      expect(id).toBeTruthy();
    }

    expect(new Set(ids).size).toBe(ids.length);

    const second = await runImport(REAL_CSV);
    expect(second.map((p) => p.item.id!)).toEqual(ids);
  });
});

describe('Robinhood import — the 11-column dialect (trademetria.com)', () => {
  // trademetria.com/integrations/robinhood documents this exact header string
  // (Account Type + Suppressed added vs. the 9-column ghostfolio.md example):
  //   "Activity Date,Process Date,Settle Date,Account Type,Instrument,
  //    Description,Trans Code,Quantity,Price,Amount,Suppressed"
  // The row values below are constructed for this test (trademetria does not
  // publish a sample row) — only the header is a verbatim cited quote. This
  // checks recognition/parsing are column-NAME-driven, not position-driven, so
  // both real dialects parse the same way.
  const WIDE_CSV =
    '"Activity Date","Process Date","Settle Date","Account Type","Instrument","Description","Trans Code","Quantity","Price","Amount","Suppressed"\n' +
    '"9/18/2023","9/18/2023","9/20/2023","Individual","O","Realty Income Dividend Reinvestment","Buy","0.810399","$53.85","($43.64)",""\n';

  it('still recognizes the file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robinhood-wide-'));
    try {
      const fpath = path.join(dir, 'wide.csv');
      await fs.promises.writeFile(fpath, WIDE_CSV);
      const fi = new RobinhoodFileImporter();
      const rec = await fi.recognize({}, { filename: 'wide.csv', fullPath: fpath });
      expect(rec.confidence).toBe(0.9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures Account Type and Suppressed into metadata alongside the shared 9 columns', async () => {
    const pipeline = await runImport(WIDE_CSV);
    expect(pipeline.length).toBe(1);
    const meta = pipeline[0].item.metadata;
    expect(meta['Account Type']).toBe('Individual');
    expect(meta.Amount).toBe('($43.64)');
    // An empty Suppressed cell stays absent, same as any other blank field.
    expect(meta.Suppressed).toBeUndefined();
  });
});

describe('Robinhood Trans Code classification', () => {
  // One row per Trans Code this parser's cited sources document as real
  // (see the file banner in ../robinhood.ts for the citation behind each).
  const CODE_ROWS: Array<[code: string, expectedClassification: string]> = [
    ['Buy', 'payment'],
    ['Sell', 'sale'],
    ['CDIV', 'credit'],
    ['INT', 'credit'],
    ['ACH', 'transfer'],
    ['GOLD', 'payment'],
    ['SPL', 'transaction'],
    ['CONV', 'transaction'],
    ['SXCH', 'transaction'],
    ['MRGS', 'transaction'],
    ['OEXP', 'transaction'],
    ['OASGN', 'transaction'],
    ['OEXCISE', 'transaction'],
    ['OEXC', 'transaction'],
  ];

  it.each(CODE_ROWS)('classifies Trans Code %s as %s', async (code, expected) => {
    const csv =
      REAL_HEADER +
      '\n' +
      `"1/2/2024","1/2/2024","1/4/2024","AAPL","Test row for ${code}","${code}","1","$100.00","$100.00"\n`;
    const pipeline = await runImport(csv);
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.classification).toBe(expected);
    expect(pipeline[0].item.metadata['Trans Code']).toBe(code);
  });

  it('drops a Trans Code outside the cited allow-list rather than guessing', async () => {
    const csv =
      REAL_HEADER +
      '\n' +
      '"1/2/2024","1/2/2024","1/4/2024","AAPL","Some future Robinhood feature","FUTZ","1","$100.00","$100.00"\n';
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { drop: jest.fn() });
    await runImport(csv, pipeline);
    expect(pipeline.length).toBe(0);
    expect(pipeline.drop).toHaveBeenCalledWith('unrecognized_trans_code', 'FUTZ');
  });

  it('drops a row with a blank Trans Code (a footer/running-total row)', async () => {
    const csv = REAL_HEADER + '\n' + '"","","","","Ending balance","","","",""\n';
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], { drop: jest.fn() });
    await runImport(csv, pipeline);
    expect(pipeline.length).toBe(0);
    expect(pipeline.drop).toHaveBeenCalledWith('empty_trans_code', 'Ending balance');
  });
});
