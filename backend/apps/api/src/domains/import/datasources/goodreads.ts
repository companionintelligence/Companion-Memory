/* Goodreads — library CSV export (goodreads_library_export.csv). */
import path from 'node:path';

import { CsvExportImporter, type CsvExportSpec } from './csvImporter';
import { readCsvFile } from './readers';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams, ObjectIdentifierRef } from './timeline';
import { textContent, timeframeContains } from './timeline';

const GOODREADS_FILENAME = 'goodreads_library_export.csv';

/**
 * The ISBN identifiers a Goodreads row states, in the shape
 * `CanonicalRecord.identifiers` is built from.
 *
 * Goodreads writes both columns as `="9780306406157"` (an Excel text-armour
 * idiom); the shared normalizer's non-digit strip handles that, so the raw cell
 * can be passed through. ISBN-13 first because it needs no upconversion. A row
 * with neither — Goodreads leaves both blank for many editions — mints nothing.
 */
export function isbnIdentifiers(
  isbn13: string | undefined,
  isbn10: string | undefined,
): ObjectIdentifierRef[] | undefined {
  const out: ObjectIdentifierRef[] = [];

  for (const raw of [isbn13, isbn10]) {
    const value = (raw ?? '').trim();

    // `=""` is Goodreads' spelling of "no ISBN on file".
    if (!value || !/[0-9]/.test(value)) {
      continue;
    }

    out.push({ namespace: 'isbn', value });
  }

  return out.length ? out : undefined;
}

function headerHasGoodreadsCols(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = nl === -1 ? text : text.slice(0, nl);

  // Must have "Book Id" but must NOT be Letterboxd (which also has "Name" etc.)
  return header.includes('Book Id') && !header.includes('Letterboxd URI');
}

// Parse YYYY/MM/DD date string → Date (midnight UTC)
function parseGoodreadsDate(s: string): Date | undefined {
  if (!s) {
    return undefined;
  }

  // Format is YYYY/MM/DD
  const d = new Date(`${s.replace(/\//g, '-')}T00:00:00Z`);

  return isNaN(d.getTime()) ? undefined : d;
}

export class GoodreadsFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => name === GOODREADS_FILENAME,
    headerMatches: (fpath) => this.headerMatches(fpath),
    confidence: { named: 0.97, sniffed: 0.7 },
  };

  // Read only the first ~4KB to inspect the CSV header row.
  private async headerMatches(fpath: string): Promise<boolean> {
    const head = await readHead(fpath);

    return head != null && headerHasGoodreadsCols(head);
  }

  protected async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    const rows = await readCsvFile(fpath, { log: params.log });
    if (rows == null) {
      return;
    }

    for (const row of rows) {
      try {
        this.pushRow(row, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushRow(row: Record<string, string>, params: ImportParams): void {
    // Prefer Date Read; fall back to Date Added
    const ts = parseGoodreadsDate(row['Date Read'] || '') ?? parseGoodreadsDate(row['Date Added'] || '');
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const title = row['Title'] || '';
    const review = row['My Review'] || '';
    // Use 'annotation' if the user left a review, otherwise 'interaction'
    // Both reviewed and shelved books are reading annotations → route to content
    // (reading.annotation). 'interaction' was unmapped and fell through to a
    // generic event; only the review.txt/book.txt filename now reflects the diff.
    const classification = 'annotation';

    params.pipeline.push({
      item: {
        id: `goodreads:${row['Book Id'] || row['ISBN13'] || row['ISBN'] || `${title}|${row['Author'] || ''}`}`,
        classification,
        timestamp: ts,
        content: textContent(review ? 'review.txt' : 'book.txt', review || title),
        metadata: {
          Title: title || undefined,
          Author: row['Author'] || undefined,
          // The review body. `reading.annotation` routes to `content` only and
          // that row's `text` is read from metadata by `descriptionFor`; the
          // review.txt blob attached above is never loaded on the push path.
          // Left undefined for a shelved-but-unreviewed book so `titleFor`
          // keeps the bare book name rather than appending an empty excerpt.
          Text: review || undefined,
          MyRating: row['My Rating'] || undefined,
          AverageRating: row['Average Rating'] || undefined,
          ExclusiveShelf: row['Exclusive Shelf'] || undefined,
          DateRead: row['Date Read'] || undefined,
          DateAdded: row['Date Added'] || undefined,
          ISBN: row['ISBN'] || undefined,
          ISBN13: row['ISBN13'] || undefined,
          // The canonical identifier list, so this book mints a PRODUCT MODEL
          // (a catalogue entry keyed by ISBN-13) that the same book bought on
          // Amazon or scanned off its barcode resolves to as well.
          Identifiers: isbnIdentifiers(row['ISBN13'], row['ISBN']),
          Publisher: row['Publisher'] || undefined,
          Binding: row['Binding'] || undefined,
          NumberOfPages: row['Number of Pages'] || undefined,
          YearPublished: row['Year Published'] || undefined,
          Bookshelves: row['Bookshelves'] || undefined,
          Source: 'Goodreads',
        },
      },
    });
  }
}

registerDataSource({
  name: 'goodreads',
  title: 'Goodreads',
  icon: '',
  description: 'Book library and reading history from a Goodreads CSV export (goodreads_library_export.csv).',
  newFileImporter: () => new GoodreadsFileImporter(),
});
