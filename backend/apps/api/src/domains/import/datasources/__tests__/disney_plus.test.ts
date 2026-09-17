import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  linesOf,
  parseDisneyDate,
  parseDisneyReport,
  parseTsvWords,
  splitSeasonCell,
  type DisneyReport,
} from '../_disney_report';
import { resetPdftotextProbe } from '../_pdftotext';
import { DisneyPlusFileImporter, serviceName } from '../disney_plus';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const EXPORT_DIR = path.join(FIXTURES_DIR, 'disney-plus-export');
const PDF_FILE = path.join(EXPORT_DIR, 'A1B2C3D4E5_Final.pdf');
// pdftotext's `-tsv` rendering of PDF_FILE, written by make_report.py in the
// same directory: the parser tests read it so they run without poppler.
const TSV_FILE = path.join(EXPORT_DIR, 'A1B2C3D4E5_Final.tsv');

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

function fixtureReport(): DisneyReport {
  return parseDisneyReport(fs.readFileSync(TSV_FILE, 'utf8'));
}

function emitFixture(overrides: Partial<ImportParams> = {}) {
  const t = testParams(overrides);
  new DisneyPlusFileImporter().emit(fixtureReport(), t.params);

  return t;
}

/**
 * A `-tsv` text built from words placed by hand: `[page, left, top, text]`.
 * Lets a parser test state a table's geometry without a PDF.
 */
function tsvOf(words: [number, number, number, string][]): string {
  const header =
    'level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const rows = words.map(
    ([page, left, top, text], i) => `5\t${page}\t1\t1\t1\t${i}\t${left}\t${top}\t20\t8\t-1\t${text}`,
  );

  return [header, `1\t1\t0\t0\t0\t0\t0\t0\t612\t792\t-1\t###PAGE###`, ...rows].join('\n');
}

/**
 * A one-page PDF that is not a Disney report, for the recognizer to refuse.
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
  const fpath = path.join(dir, 'ZZZZZZZZZZ_Final.pdf');
  fs.writeFileSync(fpath, body, 'latin1');

  return fpath;
}

describe('Disney report TSV parser', () => {
  const report = fixtureReport();
  const rows = report.titlesWatched.rows;

  it('reads the titles table with its printed header and nothing from the other sheets', () => {
    expect(report.titlesWatched.columns).toEqual(['Date', 'Service', 'Profile', 'Program', 'Season']);
    expect(rows).toHaveLength(52);
    const text = JSON.stringify(report);
    expect(text).not.toContain('Lovelace'); // profile sheet
    expect(text).not.toContain('3 Year Offer'); // subscription details
    expect(text).not.toContain('ABBOTT'); // advertising brands
    expect(text).not.toContain('PERSONALIZATION'); // the parks sheet after the table
    expect(text).not.toContain('Avatar');
  });

  it('reads a plain row into the five columns', () => {
    expect(rows[0]).toEqual({
      Date: '30 May, 2026',
      Service: 'disney',
      Profile: 'Bo',
      Program: 'This Little Wiggy',
      Season: 'The Simpsons',
    });
    // No Season printed: the key is absent, not empty.
    expect(rows[2]).toEqual({
      Date: '18 Apr, 2026',
      Service: 'disney',
      Profile: 'Bo',
      Program: 'Tron: Ares',
    });
  });

  it('folds the wrapped lines above a dated line into that row', () => {
    expect(rows[1].Program).toBe('The Rescuers Down Under');
    expect(rows[7].Program).toBe(
      'A Marvel Studios Special Presentation: The Guardians of the Galaxy Holiday Special',
    );
    // Program and Season both wrapped.
    expect(rows[8]).toMatchObject({ Program: 'Episode 2', Season: 'Star Wars: Tales of the Underworld' });
    expect(rows[10].Program).toBe('What If…The Hulk Fought the Mech Avengers?');
  });

  it('re-joins fragments at a space unless the break was inside a token', () => {
    expect(rows[11].Program).toBe('Follow Me My Friend / To Glory at the End');
    expect(rows[12].Program).toBe('Motendo/Lifedeath - Part 1');
    expect(rows[13].Program).toBe('Tolerance Is Extinction - Part 1');
  });

  it('splits a Program from its Season by position, even one space apart', () => {
    // "Chapter 2: The Child The Mandalorian Season 1" in `-layout` text.
    expect(rows[4]).toMatchObject({ Program: 'Chapter 2: The Child', Season: 'The Mandalorian Season 1' });
  });

  it('keeps reading across the page break, where no header repeats', () => {
    const late = rows.filter((r) => r.Season === 'Star Wars: Skeleton Crew');
    expect(late).toHaveLength(30);
    expect(late[0].Program).toBe('Very Interesting, As An Astrogation Problem 30');
    expect(late[29].Program).toBe('Very Interesting, As An Astrogation Problem 1');
    expect(rows[rows.length - 1]).toEqual({
      Date: '5 Jul, 2023',
      Service: 'disney',
      Profile: 'Bo',
      Program: 'Episode 2',
      Season: 'Secret Invasion Season 1',
    });
  });

  it('keeps a row with no Program, with the column absent', () => {
    const empty = rows.filter((r) => !r.Program);
    expect(empty).toEqual([{ Date: '5 Jul, 2023', Service: 'disney', Profile: 'Bo' }]);
  });

  it('stops at the next sheet heading and honours a repeated header', () => {
    const tsv = tsvOf([
      [1, 52, 100, 'TITLES'],
      [1, 90, 100, 'WATCHED'],
      [1, 52, 120, 'Date'],
      [1, 104, 120, 'Service'],
      [1, 157, 120, 'Profile'],
      [1, 222, 120, 'Program'],
      [1, 285, 120, 'Season'],
      [1, 52, 140, '1'],
      [1, 58, 140, 'Jan,'],
      [1, 70, 140, '2026'],
      [1, 104, 140, 'disney'],
      [1, 157, 140, 'Ada'],
      [1, 222, 140, 'Pilot'],
      [1, 285, 140, 'Scrubs'],
      // A page that repeats the header, at different offsets.
      [2, 40, 60, 'Date'],
      [2, 90, 60, 'Service'],
      [2, 140, 60, 'Profile'],
      [2, 200, 60, 'Program'],
      [2, 300, 60, 'Season'],
      [2, 200, 74, 'The'],
      [2, 220, 74, 'Long'],
      [2, 40, 88, '2'],
      [2, 46, 88, 'Jan,'],
      [2, 58, 88, '2026'],
      [2, 90, 88, 'espn'],
      [2, 140, 88, 'Ada'],
      [2, 200, 88, 'Game'],
      [2, 300, 88, 'Hockey'],
      [2, 40, 110, 'DISNEY'],
      [2, 80, 110, 'PARKS'],
      [2, 40, 124, 'Avatar'],
      [2, 100, 124, 'Default'],
    ]);
    const r = parseDisneyReport(tsv);
    expect(r.titlesWatched.columns).toEqual(['Date', 'Service', 'Profile', 'Program', 'Season']);
    expect(r.titlesWatched.rows).toEqual([
      { Date: '1 Jan, 2026', Service: 'disney', Profile: 'Ada', Program: 'Pilot', Season: 'Scrubs' },
      { Date: '2 Jan, 2026', Service: 'espn', Profile: 'Ada', Program: 'The Long Game', Season: 'Hockey' },
    ]);
  });

  it('returns no columns when the titles heading is absent', () => {
    const r = parseDisneyReport(
      tsvOf([
        [1, 52, 100, 'PROFILE'],
        [1, 90, 100, 'SHEET'],
      ]),
    );
    expect(r.titlesWatched).toEqual({ columns: [], rows: [] });
    expect(parseDisneyReport('').titlesWatched.rows).toEqual([]);
  });

  it('groups words into lines by page and baseline', () => {
    const words = parseTsvWords(
      tsvOf([
        [1, 100, 50.0, 'b'],
        [1, 40, 50.4, 'a'],
        [1, 40, 64, 'c'],
        [2, 40, 50, 'd'],
      ]),
    );
    expect(linesOf(words).map((l) => [l.page, l.words.map((w) => w.text).join(' ')])).toEqual([
      [1, 'a b'],
      [1, 'c'],
      [2, 'd'],
    ]);
  });

  it('parses the day as midnight UTC and reads the Season cell', () => {
    expect(parseDisneyDate('30 May, 2026')?.toISOString()).toBe('2026-05-30T00:00:00.000Z');
    expect(parseDisneyDate('9 Feb 2026')?.toISOString()).toBe('2026-02-09T00:00:00.000Z');
    expect(parseDisneyDate('9 February, 2026')?.toISOString()).toBe('2026-02-09T00:00:00.000Z');
    expect(parseDisneyDate('2026-05-30')).toBeUndefined();
    expect(parseDisneyDate('')).toBeUndefined();
    expect(splitSeasonCell('Andor Season 2')).toEqual({ series: 'Andor', season: '2' });
    expect(splitSeasonCell('Star Wars: Andor Season 13')).toEqual({
      series: 'Star Wars: Andor',
      season: '13',
    });
    expect(splitSeasonCell('Wonder Man')).toEqual({ series: 'Wonder Man', season: '' });
    expect(splitSeasonCell(undefined)).toEqual({ series: '', season: '' });
  });
});

describe('Disney+ importer', () => {
  it('names the service the report abbreviates', () => {
    expect(serviceName('disney')).toBe('Disney+');
    expect(serviceName('espn')).toBe('ESPN+');
    expect(serviceName('')).toBe('Disney+');
    expect(serviceName('star')).toBe('Star+');
  });

  it('emits one watch event per row, titled in the Netflix shape, sharing the content row per title', () => {
    const { pipeline, drops } = emitFixture();
    const watches = pipeline.filter((g) => g.item.classification === 'watch');
    expect(watches).toHaveLength(51);
    expect(drops).toEqual(['no_title']);

    const first = watches[0].item;
    expect(first.id).toBe('disney_plus:watch:30 May, 2026:Bo:The Simpsons: This Little Wiggy');
    expect(first.timestamp?.toISOString()).toBe('2026-05-30T00:00:00.000Z');
    expect(first.metadata.Title).toBe('The Simpsons: This Little Wiggy');
    expect(first.metadata.SeriesName).toBe('The Simpsons');
    expect(first.metadata.Season).toBeUndefined();
    expect(first.metadata.EpisodeName).toBe('This Little Wiggy');
    expect(first.metadata.Profile).toBe('Bo');
    expect(first.metadata.Service).toBe('Disney+');
    expect(first.metadata.Source).toBe('Disney+');
    // No `Episode`/`Series` keys: titleFor would title the event by the episode alone.
    expect(first.metadata.Episode).toBeUndefined();
    expect(first.metadata.Series).toBeUndefined();
    expect(first.content.mediaType).toBe('application/dash+xml');
    expect(first.metadata.URI).toMatch(/^disney_plus:title:[0-9a-f]{16}$/);

    // A series with its season.
    const mando = watches[3].item;
    expect(mando.metadata.Title).toBe('The Mandalorian: Season 1: Chapter 1: The Mandalorian');
    expect(mando.metadata.Season).toBe('1');

    // A film: no series, no season, the program is the title.
    const movie = watches[2].item;
    expect(movie.metadata.Title).toBe('Tron: Ares');
    expect(movie.metadata.SeriesName).toBeUndefined();
    expect(movie.metadata.EpisodeName).toBeUndefined();

    // ESPN+ rows keep their own service name.
    const espn = watches.find((g) => g.item.metadata.Service === 'ESPN+')?.item;
    expect(espn?.metadata.Title).toBe('College Football: Michigan vs. Ohio State');
    expect(espn?.metadata.Source).toBe('ESPN+');
  });

  it('gives byte-identical rows distinct ids and one content URI', () => {
    const { pipeline } = emitFixture();
    const holiday = pipeline.filter(
      (g) => g.item.metadata.Title === 'The Guardians of the Galaxy Holiday Special',
    );
    expect(holiday).toHaveLength(2);
    expect(holiday[0].item.id).toBe(
      'disney_plus:watch:24 Dec, 2025:Bo:The Guardians of the Galaxy Holiday Special',
    );
    expect(holiday[1].item.id).toBe(
      'disney_plus:watch:24 Dec, 2025:Bo:The Guardians of the Galaxy Holiday Special:1',
    );
    expect(holiday[0].item.metadata.URI).toBe(holiday[1].item.metadata.URI);

    // The episode listed by number and by title on one day stays two plays.
    const wonder = pipeline.filter((g) => g.item.metadata.SeriesName === 'Wonder Man');
    expect(wonder.map((g) => g.item.metadata.Title)).toEqual([
      'Wonder Man: Episode 8',
      'Wonder Man: Yucca Valley',
    ]);
    expect(wonder[0].item.metadata.URI).not.toBe(wonder[1].item.metadata.URI);
  });

  it('keeps a row whose date it cannot read as a watched title without a timestamp', () => {
    const report: DisneyReport = {
      titlesWatched: {
        columns: ['Date', 'Service', 'Profile', 'Program', 'Season'],
        rows: [{ Date: 'sometime', Service: 'disney', Profile: 'Ada', Program: 'Elio' }],
      },
    };
    const warnings: string[] = [];
    const t = testParams({
      log: (_level: string, msg: string) => warnings.push(msg),
    } as Partial<ImportParams>);
    new DisneyPlusFileImporter().emit(report, t.params);
    expect(t.pipeline).toHaveLength(1);
    expect(t.pipeline[0].item).toMatchObject({
      id: 'disney_plus:watched:ada:elio',
      classification: 'saved_media',
      metadata: { Title: 'Elio', Kind: 'watched' },
    });
    expect(t.pipeline[0].item.timestamp).toBeUndefined();
    expect(warnings).toEqual(['Unparseable watch date, importing as undated']);
  });

  it('applies the timeframe', () => {
    const { pipeline } = emitFixture({ timeframe: { since: new Date('2026-01-01T00:00:00Z') } });
    expect(pipeline.every((g) => g.item.timestamp!.getTime() >= Date.UTC(2026, 0, 1))).toBe(true);
    expect(pipeline).toHaveLength(7);
  });

  it('emits the titles table and nothing else', () => {
    const { pipeline } = emitFixture();
    expect(new Set(pipeline.map((g) => g.item.classification))).toEqual(new Set(['watch']));
    const text = JSON.stringify(pipeline.map((g) => g.item.metadata));
    expect(text).not.toContain('Lovelace'); // profile sheet
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('3 Year Offer'); // subscription details
    expect(text).not.toContain('ABBOTT'); // advertising
    expect(text).not.toContain('Avatar'); // parks personalization
  });
});

describeIfPdftotext('Disney+ importer with pdftotext', () => {
  beforeEach(() => resetPdftotextProbe());

  it('recognizes the report by name and cover text, and its folder', async () => {
    const fi = new DisneyPlusFileImporter();
    expect(
      (await fi.recognize({}, { filename: 'A1B2C3D4E5_Final.pdf', fullPath: PDF_FILE })).confidence,
    ).toBe(0.9);
    expect(
      (await fi.recognize({}, { filename: 'disney-plus-export', fullPath: EXPORT_DIR })).confidence,
    ).toBe(0.9);
  });

  it('recognizes a renamed report by its cover text alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disney-renamed-'));
    const renamed = path.join(dir, 'my disney data.pdf');
    fs.copyFileSync(PDF_FILE, renamed);
    try {
      const rec = await new DisneyPlusFileImporter().recognize(
        {},
        { filename: 'my disney data.pdf', fullPath: renamed },
      );
      expect(rec.confidence).toBe(0.85);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a PDF that is not the report, whatever its name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disney-stranger-'));
    const stranger = writeStrangerPdf(dir);
    try {
      const fi = new DisneyPlusFileImporter();
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
    await new DisneyPlusFileImporter().fileImport(
      {},
      { filename: 'A1B2C3D4E5_Final.pdf', fullPath: PDF_FILE },
      fromFile.params,
    );
    const fromDir = testParams();
    await new DisneyPlusFileImporter().fileImport(
      {},
      { filename: 'disney-plus-export', fullPath: EXPORT_DIR },
      fromDir.params,
    );

    const expected = emitFixture().pipeline;
    expect(fromFile.pipeline.map((g) => g.item.id)).toEqual(expected.map((g) => g.item.id));
    expect(fromDir.pipeline.map((g) => g.item.id)).toEqual(expected.map((g) => g.item.id));
    expect(fromFile.pipeline.filter((g) => g.item.classification === 'watch')).toHaveLength(51);
  });
});
