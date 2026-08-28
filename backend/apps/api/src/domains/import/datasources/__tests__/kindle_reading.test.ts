import fs from 'node:fs';
import path from 'node:path';

import { KindleReadingFileImporter } from '../kindle_reading';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const HEADER =
  'start_timestamp,end_timestamp,ASIN,purchased_marketplace,preferred_marketplace,device_family,' +
  'device_serial_number,device_software_version,content_type,total_reading_millis,number_of_page_flips';

const row = (
  start: string,
  end: string,
  asin: string,
  millis: string,
  flips: string,
  extra: Partial<Record<'contentType' | 'device', string>> = {},
): string =>
  [
    start,
    end,
    asin,
    'www.amazon.com',
    'www.amazon.com',
    extra.device ?? '',
    'bf0942cb09c94e9ea77bb7730e0c7c33',
    '1208746055',
    extra.contentType ?? 'E-Book',
    millis,
    flips,
  ].join(',');

const DIGITAL_ITEMS =
  'ASIN,ProductName,OrderId\n' +
  'B00JJ86YA4,"The Inheritance Trilogy",D01-1\n' +
  'B007978OY6,"The Lord Of The Rings: A Fully Illustrated Version of the Classic Fantasy Novels",D01-2\n';

const INSIGHTS =
  'ASIN,end_time,personal_document_id,product_name,reading_marketplace,start_time,total_reading_milliseconds\n' +
  'B00HUVUSZ4,2023-10-17T05:58:35.500Z,Not Available,Skin Game (Dresden Files Book 15),www.amazon.com,2023-10-17T05:58:29Z,6500\n';

const runImport = async (target: string) => {
  const pipeline: EmittedGraph[] = [];
  await new KindleReadingFileImporter().fileImport(
    {},
    { filename: path.basename(target), fullPath: target },
    {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams,
  );

  return pipeline.map((g) => g.item);
};

const importCsv = async (name: string, csv: string) => {
  const tmp = path.join(FIXTURES_DIR, `${name}.Kindle.Devices.ReadingSession_v0.csv`);
  await fs.promises.writeFile(tmp, csv);
  try {
    return await runImport(tmp);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
};

describe('Kindle reading datasource', () => {
  it('recognizes the file by header, rejects unrelated CSVs', async () => {
    const fi = new KindleReadingFileImporter();
    const named = path.join(FIXTURES_DIR, '__rec__.Kindle.Devices.ReadingSession_v0.csv');
    const renamed = path.join(FIXTURES_DIR, '__rec_kindle__.export.csv');
    const unrelated = path.join(FIXTURES_DIR, '__rec_kindle__.other.csv');
    await fs.promises.writeFile(named, HEADER + '\n');
    await fs.promises.writeFile(renamed, HEADER + '\n');
    await fs.promises.writeFile(unrelated, '"Start Time","Title","Profile Name"\n');
    try {
      expect(
        (await fi.recognize({}, { filename: path.basename(named), fullPath: named })).confidence,
      ).toBeGreaterThan(0.9);
      expect(
        (await fi.recognize({}, { filename: path.basename(renamed), fullPath: renamed })).confidence,
      ).toBeGreaterThan(0.8);
      expect(
        (await fi.recognize({}, { filename: path.basename(unrelated), fullPath: unrelated })).confidence,
      ).toBe(0);
    } finally {
      for (const f of [named, renamed, unrelated]) {
        await fs.promises.unlink(f).catch(() => {});
      }
    }
  });

  it('emits one read event per session with span, duration, and page flips', async () => {
    const items = await importCsv(
      '__sessions__',
      [
        HEADER,
        row('2018-02-23T18:15:25Z', '2018-02-23T18:15:33Z', 'B00JJ86YA4', '4500', '1'),
        row('2021-05-01T10:00:00Z', '2021-05-01T10:45:00Z', 'B007978OY6', '2400000', '120', {
          device: 'KINDLE',
        }),
      ].join('\n'),
    );
    expect(items.length).toBe(2);
    const [a, b] = items;
    expect(a.classification).toBe('read');
    // The book's type — Amazon's ebook format — not the text stub's.
    expect(a.content.mediaType).toBe('application/vnd.amazon.ebook');
    expect(a.timestamp?.toISOString()).toBe('2018-02-23T18:15:25.000Z');
    expect(a.timespanEnd?.toISOString()).toBe('2018-02-23T18:15:33.000Z');
    expect(a.metadata['Minutes Read']).toBe(0.1);
    expect(a.metadata['Page Flips']).toBe(1);
    expect(a.metadata.URI).toBe('kindle:asin:B00JJ86YA4');
    expect(b.metadata['Minutes Read']).toBe(40);
    expect(b.metadata.Device).toBe('KINDLE');
    // No title source in reach of a bare file drop in an empty dir — the
    // fixtures dir has none, so Title stays unset rather than inventing one.
    expect(new Set(items.map((i) => i.id!)).size).toBe(2);
  });

  it('joins titles from Digital Items.csv, falling back to the insights file', async () => {
    const dir = path.join(FIXTURES_DIR, '__kindle_dir__');
    await fs.promises.mkdir(path.join(dir, 'Additional Data', 'Kindle.Devices.ReadingSession_v0'), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(dir, 'Additional Data', 'Digital-Ordering.1'), { recursive: true });
    await fs.promises.mkdir(
      path.join(
        dir,
        'Additional Data',
        'Kindle.ReadingInsights',
        'datasets',
        'Kindle.reading-insights-sessions_with_adjustments',
      ),
      { recursive: true },
    );
    await fs.promises.writeFile(
      path.join(
        dir,
        'Additional Data',
        'Kindle.Devices.ReadingSession_v0',
        'Kindle.Devices.ReadingSession_v0.csv',
      ),
      [
        HEADER,
        row('2018-02-23T18:15:25Z', '2018-02-23T18:16:33Z', 'B00JJ86YA4', '45000', '1'),
        row('2023-10-17T05:58:29Z', '2023-10-17T05:58:35Z', 'B00HUVUSZ4', '6500', '2'),
        row(
          '2022-01-01T00:00:00Z',
          '2022-01-01T00:10:00Z',
          '6cb8e261-a9e5-4814-9b06-1d4994a9c239',
          '600000',
          '5',
        ),
        row('2022-02-01T00:00:00Z', '2022-02-01T00:10:00Z', '', '600000', '5', {
          contentType: 'Personal Document',
        }),
      ].join('\n'),
    );
    await fs.promises.writeFile(
      path.join(dir, 'Additional Data', 'Digital-Ordering.1', 'Digital Items.csv'),
      DIGITAL_ITEMS,
    );
    await fs.promises.writeFile(
      path.join(
        dir,
        'Additional Data',
        'Kindle.ReadingInsights',
        'datasets',
        'Kindle.reading-insights-sessions_with_adjustments',
        'Kindle.reading-insights-sessions_with_adjustments.csv',
      ),
      INSIGHTS,
    );
    try {
      const rec = await new KindleReadingFileImporter().recognize(
        {},
        { filename: path.basename(dir), fullPath: dir },
      );
      expect(rec.confidence).toBeGreaterThan(0.9);

      const items = await runImport(dir);
      expect(items.length).toBe(4);
      expect(items[0].metadata.Title).toBe('The Inheritance Trilogy');
      expect(items[0].metadata.ASIN).toBe('B00JJ86YA4');
      expect(items[0].metadata.URL).toBe('https://www.amazon.com/dp/B00JJ86YA4');
      // Not in Digital Items — the insights file supplies the name.
      expect(items[1].metadata.Title).toBe('Skin Game (Dresden Files Book 15)');
      // UUID pseudo-ASIN: no title exists anywhere; sessions still collapse
      // onto a per-document URI.
      expect(items[2].metadata.Title).toBeUndefined();
      expect(items[2].metadata.URI).toBe('kindle:doc:6cb8e261-a9e5-4814-9b06-1d4994a9c239');
      expect(items[2].metadata.ASIN).toBeUndefined();
      expect(items[2].metadata.URL).toBeUndefined();
      // No ASIN at all, flagged a personal document.
      expect(items[3].metadata.Title).toBe('Personal document');
      expect(items[3].metadata.URI).toBeUndefined();
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers a missing start from end − millis, or anchors at the end alone', async () => {
    const items = await importCsv(
      '__nostart__',
      [
        HEADER,
        // Start recoverable: end 10:00:00, 10 minutes read → start 09:50:00.
        row('Not Available', '2019-03-15T10:00:00Z', 'B00JJ86YA4', '600000', '10'),
        // The observed real shape: no start AND no millis — an end-only instant.
        row('Not Available', '2018-03-15T10:17:07Z', 'B00JJ86YA4', '', ''),
        // Nothing usable at all: dropped.
        row('Not Available', 'Not Available', 'B00JJ86YA4', '1000', '1'),
      ].join('\n'),
    );
    expect(items.length).toBe(2);
    const [recovered, instant] = items;
    expect(recovered.timestamp?.toISOString()).toBe('2019-03-15T09:50:00.000Z');
    expect(recovered.timespanEnd?.toISOString()).toBe('2019-03-15T10:00:00.000Z');
    expect(recovered.metadata['Minutes Read']).toBe(10);
    expect(instant.timestamp?.toISOString()).toBe('2018-03-15T10:17:07.000Z');
    expect(instant.timespanEnd).toBeUndefined();
    expect(instant.metadata['Minutes Read']).toBeUndefined();
  });

  it('respects the timeframe filter and yields idempotent, collision-free ids', async () => {
    const dup = row('2021-05-01T10:00:00Z', '2021-05-01T10:45:00Z', 'B007978OY6', '2400000', '120');
    const csv = [
      HEADER,
      row('2018-02-23T18:15:25Z', '2018-02-23T18:15:33Z', 'B00JJ86YA4', '4500', '1'),
      dup,
      dup, // true duplicate row still gets its own stable id
    ].join('\n');
    const all = await importCsv('__frame__', csv);
    expect(all.length).toBe(3);
    expect(new Set(all.map((i) => i.id!)).size).toBe(3);
    const again = await importCsv('__frame__', csv);
    expect(again.map((i) => i.id!)).toEqual(all.map((i) => i.id!));

    const tmp = path.join(FIXTURES_DIR, '__frame2__.Kindle.Devices.ReadingSession_v0.csv');
    await fs.promises.writeFile(tmp, csv);
    try {
      const pipeline: EmittedGraph[] = [];
      await new KindleReadingFileImporter().fileImport({}, { filename: path.basename(tmp), fullPath: tmp }, {
        pipeline,
        timeframe: { since: new Date('2020-01-01T00:00:00Z') },
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(2);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });
});
