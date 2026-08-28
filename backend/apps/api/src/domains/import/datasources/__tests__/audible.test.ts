import fs from 'node:fs';
import path from 'node:path';

import { AudibleFileImporter } from '../audible';
import type { ImportParams } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const HEADER =
  'ASIN,"App Version","Asin Owned","Audio Type","Book Length Milliseconds",Bookmark,"Delivery Type",' +
  '"End Date","End Position Milliseconds","Event Duration Milliseconds","Listening Mode","Local Timezone",' +
  '"Narration Speed","Product Name","Start Date","Start Position Milliseconds",Store';

const row = (
  asin: string,
  name: string,
  start: string,
  end: string,
  startPos: string,
  endPos: string,
  dur: string,
  extra: Partial<Record<'bookLen' | 'mode' | 'speed', string>> = {},
): string =>
  [
    asin,
    '3.97.0',
    'No',
    'FullTitle',
    extra.bookLen ?? '118009687',
    '0',
    'Download',
    end,
    endPos,
    dur,
    extra.mode ?? 'Online',
    'America/Los_Angeles',
    extra.speed ?? '1.00',
    `"${name}"`,
    start,
    startPos,
    'Audible',
  ].join(',');

const LIBRARY_HEADER = 'ASIN,Authors,"Audiobook Narrator","Book Series Info",Subtitle';

const runImport = async (target: string) => {
  const pipeline: EmittedGraph[] = [];
  const drops: Array<[string, string | undefined]> = [];
  (pipeline as TestPipeline).drop = (reason: string, detail?: string) => drops.push([reason, detail]);
  await new AudibleFileImporter().fileImport({}, { filename: path.basename(target), fullPath: target }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return { items: pipeline.map((g) => g.item), drops };
};

const importCsv = async (name: string, csv: string) => {
  const tmp = path.join(FIXTURES_DIR, `${name}.Listening History.csv`);
  await fs.promises.writeFile(tmp, csv);
  try {
    return await runImport(tmp);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
};

describe('Audible datasource', () => {
  it('recognizes the file by header (name alone proves nothing), rejects unrelated CSVs', async () => {
    const fi = new AudibleFileImporter();
    const named = path.join(FIXTURES_DIR, '__rec__.Listening History.csv');
    const renamed = path.join(FIXTURES_DIR, '__rec__.export.csv');
    // Another service could plausibly ship a "Listening History.csv" — without
    // the Audible header it must NOT be claimed.
    const impostor = path.join(FIXTURES_DIR, '__rec2__.Listening History.csv');
    const unrelated = path.join(FIXTURES_DIR, '__rec__.other.csv');
    await fs.promises.writeFile(named, HEADER + '\n');
    await fs.promises.writeFile(renamed, HEADER + '\n');
    await fs.promises.writeFile(impostor, '"Track Name","Artist","Played At"\n');
    await fs.promises.writeFile(unrelated, '"Start Time","Title","Profile Name"\n'); // netflix-shaped
    try {
      expect(
        (await fi.recognize({}, { filename: path.basename(named), fullPath: named })).confidence,
      ).toBeGreaterThan(0.9);
      expect(
        (await fi.recognize({}, { filename: path.basename(renamed), fullPath: renamed })).confidence,
      ).toBeGreaterThan(0.8);
      expect(
        (await fi.recognize({}, { filename: path.basename(impostor), fullPath: impostor })).confidence,
      ).toBe(0);
      expect(
        (await fi.recognize({}, { filename: path.basename(unrelated), fullPath: unrelated })).confidence,
      ).toBe(0);
    } finally {
      for (const f of [named, renamed, impostor, unrelated]) {
        await fs.promises.unlink(f).catch(() => {});
      }
    }
  });

  it('collapses part-replicated rows to one event under the core title', async () => {
    // One real session of a multi-part book: base + Part 1 + Part 2, identical
    // except Product Name — the export's replication quirk.
    const csv = [
      HEADER,
      row(
        'B00P0277C2',
        'The Three-Body Problem (Unabridged)',
        '2025-10-04',
        '2025-10-04',
        '5386578',
        '5800431',
        '414805',
        { bookLen: '48375726' },
      ),
      row(
        'B00P0277C2',
        'The Three-Body Problem (Unabridged) Part 2',
        '2025-10-04',
        '2025-10-04',
        '5386578',
        '5800431',
        '414805',
        { bookLen: '48375726' },
      ),
      row(
        'B00P0277C2',
        'The Three-Body Problem (Unabridged) Part 1',
        '2025-10-04',
        '2025-10-04',
        '5386578',
        '5800431',
        '414805',
        { bookLen: '48375726' },
      ),
      // A later session of the same book: its own event, same content URI.
      row(
        'B00P0277C2',
        'The Three-Body Problem (Unabridged)',
        '2025-10-29',
        '2025-10-29',
        '37392160',
        '37530877',
        '138955',
        { bookLen: '48375726' },
      ),
    ].join('\n');
    const { items } = await importCsv('__parts__', csv);
    expect(items.length).toBe(2);
    expect(items.map((i) => i.metadata.Title)).toEqual([
      'The Three-Body Problem (Unabridged)',
      'The Three-Body Problem (Unabridged)',
    ]);
    expect(new Set(items.map((i) => i.id!)).size).toBe(2);
    expect(items[0].metadata.URI).toBe('audible:asin:B00P0277C2');
    expect(items[1].metadata.URI).toBe('audible:asin:B00P0277C2');
  });

  it('strips the Part suffix when a group has no base row', async () => {
    const csv = [
      HEADER,
      row(
        '0593290704',
        'Peace Talks: Dresden Files, Book 16 (Unabridged) Part 1',
        '2020-07-31',
        '2020-07-31',
        '12822040',
        '15375741',
        '2553000',
      ),
    ].join('\n');
    const { items } = await importCsv('__nobase__', csv);
    expect(items.length).toBe(1);
    expect(items[0].metadata.Title).toBe('Peace Talks: Dresden Files, Book 16 (Unabridged)');
  });

  it('anchors sessions to their day and keeps duration in metadata, not a timespan', async () => {
    const csv = [
      HEADER,
      row(
        'B00MH3D5QY',
        "Fool's Fate (Unabridged)",
        '2025-04-05',
        '2025-04-05',
        '48487997',
        '48505048',
        '17288',
        { bookLen: '118009687' },
      ),
      // Crossed midnight: End Date differs and is worth stating.
      row(
        'B002V0QK4C',
        'Unseen Academicals (Unabridged)',
        '2021-03-09',
        '2021-03-10',
        '20000000',
        '24000000',
        '4100000',
        { bookLen: '40000000', speed: '1.25' },
      ),
    ].join('\n');
    const { items } = await importCsv('__days__', csv);
    const [a, b] = items;
    expect(a.classification).toBe('listen');
    // The audiobook's type — Audible's own format — not the text stub's.
    expect(a.content.mediaType).toBe('audio/vnd.audible.aax');
    expect(a.timestamp?.toISOString()).toBe('2025-04-05T00:00:00.000Z');
    expect(a.timespanEnd).toBeUndefined();
    expect(a.metadata['Seconds Listened']).toBe(17);
    expect(a.metadata.Progress).toBe(41); // 48505048 / 118009687
    expect(a.metadata['End Date']).toBeUndefined(); // same-day end says nothing
    expect(a.metadata['Narration Speed']).toBeUndefined(); // 1.00 is the default
    expect(a.metadata.Timezone).toBe('America/Los_Angeles');
    expect(b.metadata['End Date']).toBe('2021-03-10');
    expect(b.metadata['Narration Speed']).toBe(1.25);
    expect(b.metadata.Progress).toBe(60);
  });

  it('joins Library.csv on ASIN for author, narrator, and series', async () => {
    const dir = path.join(FIXTURES_DIR, '__audible_dir__');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, 'Listening History.csv'),
      [
        HEADER,
        row(
          'B00XP2TTMU',
          "Fool's Quest (Unabridged)",
          '2025-04-05',
          '2025-04-05',
          '1000000',
          '2000000',
          '900000',
        ),
        row(
          'B0G4XLZ7R7',
          'Out Law: A Dresden Files Novella',
          '2026-06-20',
          '2026-06-20',
          '0',
          '600000',
          '600000',
        ),
        row('B000000000', 'Not In Library (Unabridged)', '2024-01-01', '2024-01-01', '0', '1000', '1000'),
      ].join('\n'),
    );
    await fs.promises.writeFile(
      path.join(dir, 'Library.csv'),
      [
        LIBRARY_HEADER,
        'B00XP2TTMU,"Robin Hobb","Elliot Hill","asin:B0757BYXZK,title:Realms of the Elderlings,asin:B00L2MBDSI,title:Fitz and the Fool","Fitz and the Fool, Book 2"',
        'B0G4XLZ7R7,"Jim Butcher","James Marsters","asin:B005NB2IG0,title:The Dresden Files","Dresden Files, Book 18.5"',
      ].join('\n'),
    );
    try {
      const rec = await new AudibleFileImporter().recognize(
        {},
        { filename: path.basename(dir), fullPath: dir },
      );
      expect(rec.confidence).toBeGreaterThan(0.9);

      const { items } = await runImport(dir);
      expect(items.length).toBe(3);
      const fools = items.find((i) => i.metadata.ASIN === 'B00XP2TTMU')!;
      expect(fools.metadata.Author).toBe('Robin Hobb');
      expect(fools.metadata.URL).toBe('https://www.audible.com/pd/B00XP2TTMU');
      expect(fools.metadata.Narrator).toBe('Elliot Hill');
      expect(fools.metadata.Series).toBe('Realms of the Elderlings, Fitz and the Fool');
      expect(fools.metadata.Subtitle).toBe('Fitz and the Fool, Book 2');
      const dresden = items.find((i) => i.metadata.ASIN === 'B0G4XLZ7R7')!;
      expect(dresden.metadata.Series).toBe('The Dresden Files');
      // A book missing from Library.csv still imports, just unenriched.
      const bare = items.find((i) => i.metadata.ASIN === 'B000000000')!;
      expect(bare.metadata.Author).toBeUndefined();
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('respects the timeframe filter and yields idempotent ids', async () => {
    const csv = [
      HEADER,
      row('B00MH3D5QY', 'Old Book (Unabridged)', '2019-06-03', '2019-06-03', '0', '500000', '500000'),
      row('B00P0277C2', 'New Book (Unabridged)', '2025-10-04', '2025-10-04', '0', '500000', '500000'),
    ].join('\n');
    const all = await importCsv('__frame__', csv);
    expect(all.items.length).toBe(2);
    const again = await importCsv('__frame__', csv);
    expect(again.items.map((i) => i.id!)).toEqual(all.items.map((i) => i.id!));

    const tmp = path.join(FIXTURES_DIR, '__frame2__.Listening History.csv');
    await fs.promises.writeFile(tmp, csv);
    try {
      const pipeline: EmittedGraph[] = [];
      await new AudibleFileImporter().fileImport({}, { filename: path.basename(tmp), fullPath: tmp }, {
        pipeline,
        timeframe: { since: new Date('2020-01-01T00:00:00Z') },
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.metadata.Title).toBe('New Book (Unabridged)');
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });
});
