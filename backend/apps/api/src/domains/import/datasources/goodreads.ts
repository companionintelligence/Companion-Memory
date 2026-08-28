/* Goodreads — library CSV export (goodreads_library_export.csv). */
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, ObjectIdentifierRef } from './timeline';
import { timeframeContains } from './timeline';

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

export class GoodreadsFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      const base = path.basename(root).toLowerCase();
      if (base === GOODREADS_FILENAME) {
        return { confidence: 0.97 };
      }

      if (path.extname(base) === '.csv' && (await this.headerMatches(root))) {
        return { confidence: 0.7 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        if (names.some((n) => n.toLowerCase() === GOODREADS_FILENAME)) {
          return { confidence: 0.97 };
        }

        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.csv') {
            continue;
          }

          if (await this.headerMatches(path.join(root, name))) {
            return { confidence: 0.7 };
          }
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  // Read only the first ~4KB to inspect the CSV header row.
  private async headerMatches(fpath: string): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(fpath, 'r');
      const buf = Buffer.alloc(4096);
      const { bytesRead: n } = await handle.read(buf, 0, 4096, 0);

      return headerHasGoodreadsCols(buf.toString('utf8', 0, n));
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    if (stat.isFile()) {
      await this.processFile(root, params);
    } else if (stat.isDirectory()) {
      let names: string[];
      try {
        names = fs.readdirSync(root);
      } catch {
        return;
      }

      const exact = names.find((n) => n.toLowerCase() === GOODREADS_FILENAME);
      if (exact) {
        await this.processFile(path.join(root, exact), params);
      } else {
        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.csv') {
            continue;
          }

          const fpath = path.join(root, name);
          if (await this.headerMatches(fpath)) {
            await this.processFile(fpath, params);
          }
        }
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

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
        content: {
          filename: review ? 'review.txt' : 'book.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(review || title),
        },
        metadata: {
          Title: title || undefined,
          Author: row['Author'] || undefined,
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
