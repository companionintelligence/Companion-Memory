import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cellValue, joinWrapped, parseHuluReport, parseHuluTimestamp, splitCells } from '../_hulu_report';
import { resetPdftotextProbe } from '../_pdftotext';
import { composeWatchTitle, HuluFileImporter } from '../hulu';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const EXPORT_DIR = path.join(FIXTURES_DIR, 'hulu-export');
const PDF_FILE = path.join(EXPORT_DIR, 'rtk-report-24681357.pdf');
// pdftotext's `-layout` rendering of PDF_FILE, written by make_report.py in
// the same directory: the parser tests read it so they run without poppler.
const LAYOUT_FILE = path.join(EXPORT_DIR, 'rtk-report-24681357.layout.txt');

function pdftotextAvailable(): boolean {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
}

// The PDF-level tests need the binary the appliance image ships; a developer
// machine without poppler skips them and still runs everything below the read.
const describeIfPdftotext = pdftotextAvailable() ? describe : describe.skip;

function testParams(overrides: Partial<ImportParams> = {}): {
  params: ImportParams;
  pipeline: EmittedGraph[];
  drops: string[];
} {
  const pipeline: EmittedGraph[] = [];
  const drops: string[] = [];
  const params = {
    pipeline: {
      push: (g: EmittedGraph) => pipeline.push(g),
      drop: (reason: string) => drops.push(reason),
    },
    timeframe: {},
    log: () => {},
    ...overrides,
  } as unknown as ImportParams;

  return { params, pipeline, drops };
}

function emitFixture(overrides: Partial<ImportParams> = {}) {
  const report = parseHuluReport(fs.readFileSync(LAYOUT_FILE, 'utf8'));
  const t = testParams(overrides);
  new HuluFileImporter().emit(report, t.params);

  return t;
}

/**
 * A one-page PDF that is not a Hulu report, for the recognizer to refuse.
 * Hand-assembled so the test needs no PDF library; poppler accepts it.
 */
function writeStrangerPdf(dir: string): string {
  const content = 'BT /F1 24 Tf 72 700 Td (Quarterly Report) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`;
  }

  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const fpath = path.join(dir, 'rtk-report-99999999.pdf');
  fs.writeFileSync(fpath, body, 'latin1');

  return fpath;
}

describe('Hulu report layout parser', () => {
  const report = parseHuluReport(fs.readFileSync(LAYOUT_FILE, 'utf8'));

  it('reads the key/value grids, including a key and a value that wrapped', () => {
    expect(report.personal).toEqual({
      'First Name': 'Ada',
      'Last Name': 'Lovelace',
      'Account Name': 'Ada Lovelace',
      Email: 'ada@example.com',
      Birthdate: '1990-01-02',
      Gender: 'Prefer Not To Say',
      'Home Zip': 'N/A',
    });
    expect(report.subscription['Plan']).toBe('Hulu (With Ads)');
    expect(report.subscription['Status']).toBe('GOOD_STANDING');
    // "Last Charged Date /" on one line, "Amount:" on the next.
    expect(report.subscription['Last Charged Date / Amount']).toBe('N/A / 19.98 USD');
    expect(report.subscription['Next Charge Date / Amount']).toBe('N/A / N/A');
    // The value wrapped onto a second line with no key beside it.
    expect(report.subscription['Add Ons']).toBe('Disney+ (With Ads), ESPN Select');
  });

  it('reads the watch history with its printed header and skips the sections it does not import', () => {
    expect(report.watchHistory.columns).toEqual(['Episode Name', 'Series Name', 'Season', 'Last Played At']);
    expect(report.watchHistory.rows).toHaveLength(45);
    // Plan Details, Subscription History, Profiles, Tastes, Cloud DVR and
    // Devices are in the fixture; none of their text leaks into another
    // section or registers as an unknown heading.
    expect(report.unknownSections).toEqual([]);
    expect(report.watchHistory.rows.some((r) => r['Episode Name'] === 'Activation Date')).toBe(false);
    expect(JSON.stringify(report)).not.toContain('verizon_discount');
    expect(JSON.stringify(report)).not.toContain('Funny & Lighthearted');
  });

  it('re-joins cells that wrapped at a space', () => {
    expect(report.watchHistory.rows[2]['Episode Name']).toBe('The Original Beef of Chicagoland');
    expect(report.watchHistory.rows[6]['Episode Name']).toBe('Mall Part 2: Questions & Concerns');
    expect(report.watchHistory.rows[0]['Series Name']).toBe("It's Always Sunny in Philadelphia");
  });

  it('re-reads column offsets from the header a continuation page repeats', () => {
    // The watch history crosses a page; the second page's header lays the
    // columns out at different offsets. Rows on both pages must land in the
    // right columns.
    const late = report.watchHistory.rows.find((r) => r['Episode Name'] === 'Episode 25');
    expect(late).toEqual({
      'Episode Name': 'Episode 25',
      'Series Name': 'Shifting Gears',
      Season: '2',
      'Last Played At': '25 Aug 2025 05:25:00',
    });
    // The repeated header itself is not a row.
    expect(report.watchHistory.rows.some((r) => r['Episode Name'] === 'Episode Name')).toBe(false);
  });

  it('keeps rows that have no play time, with the column absent', () => {
    const undated = report.watchHistory.rows.filter((r) => !r['Last Played At']);
    expect(undated).toHaveLength(6);
    expect(undated[0]).toEqual({
      'Episode Name': 'The Nate Bargatze Shopping Cart Nestle!',
      'Series Name': 'The Greatest Average American',
      Season: '1',
    });
  });

  it('reads the header-less advertising lists and leaves empty sections empty', () => {
    expect(report.advertisingDeviceIds).toEqual(['c984923d-a3a8-5ab3-911c-29d68d3db58e']);
    expect(report.advertisingBrands).toEqual(['ABBOTT', 'AIRBNB', 'Arhaus', 'CHEWY INC', 'HULU', 'Zevia']);
  });

  it('stops a table at a heading it does not know instead of reading its text as rows', () => {
    const text = [
      'Watch History',
      '',
      'Episode Name         Series Name   Season   Last Played At',
      '',
      'Pilot                Scrubs        1        27 Feb 2026 05:33:34',
      '',
      'Brand New Section',
      '',
      'Some prose that follows the new heading',
      '',
      'Advertising Brands History',
      '',
      'ACME',
    ].join('\n');
    const r = parseHuluReport(text);
    expect(r.watchHistory.rows).toEqual([
      {
        'Episode Name': 'Pilot',
        'Series Name': 'Scrubs',
        Season: '1',
        'Last Played At': '27 Feb 2026 05:33:34',
      },
    ]);
    expect(r.unknownSections).toEqual(['Brand New Section']);
    expect(r.advertisingBrands).toEqual(['ACME']);
  });

  it('splits cells on runs of two or more spaces only', () => {
    expect(splitCells('  Alpha beta   gamma  ')).toEqual([
      { start: 2, text: 'Alpha beta' },
      { start: 15, text: 'gamma' },
    ]);
  });

  it('joins wrapped fragments by column policy', () => {
    expect(joinWrapped('verizon_discount_in', 'clusion_offer_hybrid', 'none')).toBe(
      'verizon_discount_inclusion_offer_hybrid',
    );
    expect(joinWrapped('RECURRENCE_CHANGE_SUBSCRIPTION', '_STATUS', 'prose')).toBe(
      'RECURRENCE_CHANGE_SUBSCRIPTION_STATUS',
    );
    expect(joinWrapped('03 Sep 2026 13:', '28:00', 'punct')).toBe('03 Sep 2026 13:28:00');
    expect(joinWrapped('03 Sep 2026', '13:28:00', 'punct')).toBe('03 Sep 2026 13:28:00');
    expect(joinWrapped('Laguna niguel,', 'CA,US', 'punct')).toBe('Laguna niguel,CA,US');
    expect(joinWrapped('Rancho', 'cucamonga,CA,US', 'punct')).toBe('Rancho cucamonga,CA,US');
    expect(joinWrapped('Android -', 'samsung SM-', 'prose')).toBe('Android - samsung SM-');
    expect(joinWrapped('Android - samsung SM-', 'P613 samsung', 'prose')).toBe(
      'Android - samsung SM-P613 samsung',
    );
    expect(joinWrapped('Alien:', 'Earth', 'prose')).toBe('Alien: Earth');
    expect(joinWrapped('Mall Part 2: Questions &', 'Concerns', 'prose')).toBe(
      'Mall Part 2: Questions & Concerns',
    );
  });

  it('parses the report timestamp as UTC and treats N/A as no value', () => {
    expect(parseHuluTimestamp('03 Sep 2026 04:42:48')?.toISOString()).toBe('2026-09-03T04:42:48.000Z');
    expect(parseHuluTimestamp('31 Oct 1950')?.toISOString()).toBe('1950-10-31T00:00:00.000Z');
    expect(parseHuluTimestamp('2026-09-03')).toBeUndefined();
    expect(parseHuluTimestamp('')).toBeUndefined();
    expect(cellValue('N/A')).toBe('');
    expect(cellValue(' The Bear ')).toBe('The Bear');
  });
});

describe('Hulu importer', () => {
  it('composes titles the way the Netflix importer does', () => {
    expect(composeWatchTitle('Caramel', 'The Bear', '5')).toBe('The Bear: Season 5: Caramel');
    expect(composeWatchTitle('Eyewitness News 11PM', 'ABC7 Eyewitness News', '0')).toBe(
      'ABC7 Eyewitness News: Eyewitness News 11PM',
    );
    expect(composeWatchTitle('Edmonton Oilers vs. Vancouver Canucks', 'NHL Hockey', '')).toBe(
      'NHL Hockey: Edmonton Oilers vs. Vancouver Canucks',
    );
    expect(composeWatchTitle('The Raid: Redemption', '', '')).toBe('The Raid: Redemption');
  });

  it('emits one watch event per dated play, sharing the content row per title', () => {
    const { pipeline } = emitFixture();
    const watches = pipeline.filter((g) => g.item.classification === 'watch');
    expect(watches).toHaveLength(39);

    const first = watches[0].item;
    expect(first.id).toBe(
      "hulu:watch:03 Sep 2026 04:42:48:It's Always Sunny in Philadelphia: Season 18: 2026: A Virtual Insanity",
    );
    expect(first.timestamp?.toISOString()).toBe('2026-09-03T04:42:48.000Z');
    expect(first.metadata.Title).toBe(
      "It's Always Sunny in Philadelphia: Season 18: 2026: A Virtual Insanity",
    );
    expect(first.metadata.SeriesName).toBe("It's Always Sunny in Philadelphia");
    expect(first.metadata.Season).toBe('18');
    expect(first.metadata.EpisodeName).toBe('2026: A Virtual Insanity');
    // No `Episode`/`Series` keys: titleFor would title the event by the episode alone.
    expect(first.metadata.Episode).toBeUndefined();
    expect(first.metadata.Series).toBeUndefined();
    expect(first.content.mediaType).toBe('application/dash+xml');
    expect(first.metadata.Source).toBe('Hulu');
    expect(first.metadata.URI).toMatch(/^hulu:title:[0-9a-f]{16}$/);

    // A movie: no series, no season.
    const movie = watches[1].item;
    expect(movie.metadata.Title).toBe('The Raid: Redemption');
    expect(movie.metadata.SeriesName).toBeUndefined();
    expect(movie.metadata.Season).toBeUndefined();

    // Every play of one title carries the same URI.
    const bear = watches.filter((g) => g.item.metadata.SeriesName === 'The Bear');
    expect(bear).toHaveLength(2);
    expect(new Set(bear.map((g) => g.item.metadata.URI)).size).toBe(2); // two different episodes
    expect(bear[0].item.metadata.URI).not.toBe(bear[1].item.metadata.URI);
  });

  it('keeps undated plays as watched titles without a timestamp', () => {
    const { pipeline } = emitFixture();
    const watched = pipeline.filter((g) => g.item.metadata.Kind === 'watched');
    expect(watched).toHaveLength(6);
    expect(watched.every((g) => g.item.classification === 'saved_media')).toBe(true);
    expect(watched.every((g) => g.item.timestamp === undefined)).toBe(true);

    // Two byte-identical rows get distinct ids and share the content URI.
    const news = watched.filter((g) => g.item.metadata.EpisodeName === 'Eyewitness News 11PM');
    expect(news).toHaveLength(2);
    expect(news[0].item.id).toBe('hulu:watched:abc7 eyewitness news: eyewitness news 11pm');
    expect(news[1].item.id).toBe('hulu:watched:abc7 eyewitness news: eyewitness news 11pm:1');
    expect(news[0].item.metadata.URI).toBe(news[1].item.metadata.URI);
  });

  it('applies the timeframe to dated items only', () => {
    const { pipeline } = emitFixture({ timeframe: { since: new Date('2026-01-01T00:00:00Z') } });
    const dated = pipeline.filter((g) => g.item.timestamp !== undefined);
    expect(dated.every((g) => g.item.timestamp!.getTime() >= Date.UTC(2026, 0, 1))).toBe(true);
    expect(pipeline.filter((g) => g.item.classification === 'watch')).toHaveLength(7);
    // Undated watched titles are not filtered.
    expect(pipeline.filter((g) => g.item.metadata.Kind === 'watched')).toHaveLength(6);
  });

  it('emits watch history and nothing else', () => {
    const { pipeline } = emitFixture();
    expect(new Set(pipeline.map((g) => g.item.classification))).toEqual(new Set(['watch', 'saved_media']));
    expect(pipeline).toHaveLength(45);
    const text = JSON.stringify(pipeline.map((g) => g.item.metadata));
    expect(text).not.toContain('Lovelace'); // personal details
    expect(text).not.toContain('31 Oct 1950'); // a profile's birthdate
    expect(text).not.toContain('verizon_discount'); // plan details
    expect(text).not.toContain('ENTITLEMENT_CHANGE'); // subscription history
    expect(text).not.toContain('Funny & Lighthearted'); // tastes
    expect(text).not.toContain('136.52.105.11'); // devices and logins
    expect(text).not.toContain('AIRBNB'); // advertising
  });
});

describeIfPdftotext('Hulu importer with pdftotext', () => {
  beforeEach(() => resetPdftotextProbe());

  it('recognizes the report by name and cover text, and its folder', async () => {
    const fi = new HuluFileImporter();
    expect(
      (await fi.recognize({}, { filename: 'rtk-report-24681357.pdf', fullPath: PDF_FILE })).confidence,
    ).toBe(0.9);
    expect((await fi.recognize({}, { filename: 'hulu-export', fullPath: EXPORT_DIR })).confidence).toBe(0.9);
  });

  it('recognizes a renamed report by its cover text alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hulu-renamed-'));
    const renamed = path.join(dir, 'my hulu data.pdf');
    fs.copyFileSync(PDF_FILE, renamed);
    try {
      const rec = await new HuluFileImporter().recognize(
        {},
        { filename: 'my hulu data.pdf', fullPath: renamed },
      );
      expect(rec.confidence).toBe(0.85);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a PDF that is not the report, whatever its name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hulu-stranger-'));
    const stranger = writeStrangerPdf(dir);
    try {
      const fi = new HuluFileImporter();
      expect(
        (await fi.recognize({}, { filename: path.basename(stranger), fullPath: stranger })).confidence,
      ).toBe(0);
      expect((await fi.recognize({}, { filename: 'stranger', fullPath: dir })).confidence).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports the PDF end to end, from the file or its folder', async () => {
    const fromFile = testParams();
    await new HuluFileImporter().fileImport(
      {},
      { filename: 'rtk-report-24681357.pdf', fullPath: PDF_FILE },
      fromFile.params,
    );
    const fromDir = testParams();
    await new HuluFileImporter().fileImport(
      {},
      { filename: 'hulu-export', fullPath: EXPORT_DIR },
      fromDir.params,
    );

    const expected = emitFixture().pipeline;
    expect(fromFile.pipeline.map((g) => g.item.id)).toEqual(expected.map((g) => g.item.id));
    expect(fromDir.pipeline.map((g) => g.item.id)).toEqual(expected.map((g) => g.item.id));
    expect(fromFile.pipeline.filter((g) => g.item.classification === 'watch')).toHaveLength(39);
  });
});
