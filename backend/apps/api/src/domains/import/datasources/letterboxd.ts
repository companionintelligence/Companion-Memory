/* Letterboxd — diary/ratings/reviews CSV export (diary.csv, ratings.csv,
   reviews.csv).

   The files overlap. A diary row is one viewing, with the rating given that
   day. ratings.csv holds the latest rating per FILM, so a film that is in the
   diary would come in a second time from it; only films the diary never
   logged are taken from ratings.csv. reviews.csv repeats the diary entry a
   review was written on (same Letterboxd URI) and adds the Review text, which
   is put on that diary row. */
import path from 'node:path';

import { CsvExportImporter, type CsvExportSpec } from './csvImporter';
import { readCsvFile } from './readers';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const LETTERBOXD_FILES = ['diary.csv', 'ratings.csv', 'reviews.csv'];

function headerHasLetterboxdCols(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = nl === -1 ? text : text.slice(0, nl);

  return header.includes('Letterboxd URI');
}

// Parse YYYY-MM-DD date string → Date (midnight UTC)
function parseYMD(s: string): Date | undefined {
  if (!s) {
    return undefined;
  }

  const d = new Date(`${s}T00:00:00Z`);

  return isNaN(d.getTime()) ? undefined : d;
}

// Which of the export's files this is: by its name, else by its columns (an
// upload renamed on the way still has diary.csv's Watched Date or
// reviews.csv's Review column).
function fileKind(fpath: string, rows: Record<string, string>[]): 'diary' | 'reviews' | 'ratings' {
  const name = path.basename(fpath).toLowerCase();
  if (name === 'diary.csv' || name === 'reviews.csv' || name === 'ratings.csv') {
    return name === 'diary.csv' ? 'diary' : name === 'reviews.csv' ? 'reviews' : 'ratings';
  }

  const columns = rows.length ? Object.keys(rows[0]) : [];

  return columns.includes('Review') ? 'reviews' : columns.includes('Watched Date') ? 'diary' : 'ratings';
}

export class LetterboxdFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => LETTERBOXD_FILES.includes(name),
    headerMatches: (fpath) => this.headerMatches(fpath),
    namedNeedsHeader: true,
    confidence: { named: 0.95, sniffed: 0 },
    importInDir: 'all-named',
  };

  // Read only the first ~4KB to inspect the CSV header row.
  private async headerMatches(fpath: string): Promise<boolean> {
    const head = await readHead(fpath);

    return head != null && headerHasLetterboxdCols(head);
  }

  protected async processFile(fpath: string, params: ImportParams): Promise<void> {
    await this.importFiles([fpath], fpath, params);
  }

  // Reviews are indexed first so each can ride its diary row; ratings go last,
  // so a film the diary (or a review) already logged is not counted twice.
  protected override async importFiles(files: string[], _root: string, params: ImportParams): Promise<void> {
    type Row = Record<string, string>;
    const filmKey = (row: Row) => `${row['Name'] || ''}\0${row['Year'] || ''}`;
    const viewedOn = (row: Row) => row['Watched Date'] || row['Date'] || '';
    // A review row is matched to its diary row by URI, or by film and day
    // when it has none.
    const reviewKeys = (row: Row) => [row['Letterboxd URI'] || '', `${filmKey(row)}\0${viewedOn(row)}`];
    const byKind: Record<'diary' | 'reviews' | 'ratings', Row[]> = { diary: [], reviews: [], ratings: [] };
    for (const fpath of files) {
      const rows = await readCsvFile(fpath, { log: params.log });
      if (rows != null) {
        byKind[fileKind(fpath, rows)].push(...rows);
      }
    }

    const reviews = new Map<string, Row>();
    for (const row of byKind.reviews) {
      reviews.set(row['Letterboxd URI'] || reviewKeys(row)[1], row);
    }

    const takeReview = (row: Row): string | undefined => {
      for (const key of reviewKeys(row)) {
        const review = key ? reviews.get(key) : undefined;
        if (review) {
          reviews.delete(key);

          return review['Review'];
        }
      }

      return undefined;
    };

    const viewings: Array<{ row: Row; review?: string }> = byKind.diary.map((row) => ({
      row,
      review: takeReview(row),
    }));
    // A review whose diary row is not in this upload is still a viewing.
    for (const row of reviews.values()) {
      viewings.push({ row, review: row['Review'] });
    }

    // ratings.csv holds the film's current rating. A film logged without a
    // rating and rated afterwards has it only there, so the latest viewing of
    // such a film takes it.
    const filmRating = new Map<string, string>();
    for (const row of byKind.ratings) {
      if (row['Rating']) {
        filmRating.set(filmKey(row), row['Rating']);
      }
    }

    const latest = new Map<string, Row>();
    for (const { row } of viewings) {
      const seen = latest.get(filmKey(row));
      if (!seen || viewedOn(row) >= viewedOn(seen)) {
        latest.set(filmKey(row), row);
      }
    }

    const logged = new Set<string>();
    const push = (row: Row, review?: string, rating?: string) => {
      logged.add(filmKey(row));
      try {
        this.pushRow(row, params, review, rating);
      } catch (e) {
        params.log?.('error', 'Failed to import a Letterboxd row', { error: (e as Error).message });
      }
    };

    for (const { row, review } of viewings) {
      const rating =
        !row['Rating'] && latest.get(filmKey(row)) === row ? filmRating.get(filmKey(row)) : undefined;
      push(row, review, rating);
    }

    for (const row of byKind.ratings) {
      if (!logged.has(filmKey(row))) {
        push(row);
      }
    }
  }

  private pushRow(
    row: Record<string, string>,
    params: ImportParams,
    review?: string,
    filmRating?: string,
  ): void {
    // diary.csv has "Watched Date"; ratings.csv falls back to "Date"
    const ts = parseYMD(row['Watched Date'] || row['Date'] || '');
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const name = row['Name'] || '';
    const uri = row['Letterboxd URI'] || '';
    // Unique per diary entry (boxd.it/<id>) or per film (ratings.csv); fall back
    // to a composite so same-day films can't collapse if a URI is ever blank.
    const id =
      uri ||
      `letterboxd:${name}:${row['Year'] || ''}:${row['Watched Date'] || row['Date'] || ''}:${row['Rating'] || ''}`;
    params.pipeline.push({
      item: {
        id,
        classification: 'watch',
        timestamp: ts,
        // A Letterboxd entry is a film seen anywhere — cinema, disc, any service —
        // so there is no delivery format to name; the generic video container says
        // "a video" without claiming how it was streamed.
        content: { filename: 'watch.txt', mediaType: 'video/mp4', data: async () => Buffer.from(name) },
        metadata: {
          Name: name || undefined,
          Year: row['Year'] || undefined,
          Rating: row['Rating'] || filmRating || undefined,
          Rewatch: row['Rewatch'] || undefined,
          Tags: row['Tags'] || undefined,
          LetterboxdURI: row['Letterboxd URI'] || undefined,
          Review: review || undefined,
          // The review is the row's body: the content row's text comes from Text.
          Text: review || undefined,
          Source: 'Letterboxd',
        },
      },
    });
  }
}

registerDataSource({
  name: 'letterboxd',
  title: 'Letterboxd',
  icon: '',
  description:
    'Film watch history and reviews from a Letterboxd CSV export (diary.csv, ratings.csv, reviews.csv).',
  newFileImporter: () => new LetterboxdFileImporter(),
});
