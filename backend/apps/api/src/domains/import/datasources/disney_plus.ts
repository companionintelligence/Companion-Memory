/* Disney+ — the PDF a Disney "Data Subject Access Request" returns
   (<request id>_Final.pdf, e.g. 77VH23XCAN_Final.pdf).

   Disney ships no machine-readable export: the report is an Excel workbook
   printed to PDF, one sheet per business unit. Text comes out of it with
   poppler's `pdftotext` (`_pdftotext.ts`) and `_disney_report.ts` reads the
   one table that matters — "TITLES WATCHED" on the "DISNEY+/ESPN+ DATA
   OUTPUT" sheet — back out of the word positions.

   Titles watched → 'watch' events (kind media.watch), one per row, the
   title's content row shared across plays via metadata.URI — the netflix.ts
   / hulu.ts pattern. The row gives the day (no time; the sheet says UTC),
   the service (disney, espn), the profile, the program and, under "Season",
   the series with its season. The title is composed in Netflix's shape,
   "Series: Season N: Episode", like Hulu's, so the three services' rows read
   alike and resolve through the same Wikidata lookup.

   As printed, no more: Disney often lists an episode twice for one day —
   once by number ("Episode 8") and once by title ("Yucca Valley") — and not
   always both, so the pairs cannot be collapsed and are imported as two
   plays. A row with no Program at all (they exist) is dropped.

   Deliberately not imported: the profile sheet (the account holder is the
   appliance owner), account / subscription / profile / payment details,
   customer-service history, the advertiser list, and the parks, cruise,
   store, D23, studio and network sheets, which on a streaming-only account
   say "No specific personal information." */
import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseDisneyDate, parseDisneyReport, splitSeasonCell, type DisneyReport } from './_disney_report';
import { pdfToLayoutText, pdfToTsvText, pdftotextKnownMissing, PdftotextMissingError } from './_pdftotext';
import { composeWatchTitle, Occurrences } from './hulu';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { Graph, ImportParams } from './timeline';
import { timeframeContains } from './timeline';

/** `77VH23XCAN_Final.pdf`: the request's id, then Disney's suffix. */
const FILENAME_RE = /^[A-Z0-9]{6,20}_Final\.pdf$/i;

/** ~15 KB a page on a real report; a PDF past this is not one. */
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

/**
 * Text on the first two pages that names the document: the profile sheet
 * lists the "Disney Account Identifier(s)", and the streaming sheet that
 * follows is titled for its two services.
 */
const COVER_RE = /profile sheet[\s\S]{0,1500}disney account identifier|disney\+\s*\/\s*espn\+ data output/i;

/** The Service cell as the report prints it → the brand it means. */
const SERVICE_NAMES: Record<string, string> = {
  disney: 'Disney+',
  espn: 'ESPN+',
  hulu: 'Hulu',
  star: 'Star+',
};

export function serviceName(service: string): string {
  const key = service.trim().toLowerCase();

  return SERVICE_NAMES[key] ?? (key ? service.trim() : 'Disney+');
}

/**
 * Stable per-title identity for the content row: case/whitespace-insensitive
 * hash of the composed title, so every play of one episode (and every
 * re-export) lands on ONE content row while each play stays its own event.
 * sha256 like netflix.ts, so Postgres can recompute it by hand.
 */
function titleUri(title: string): string {
  return `disney_plus:title:${crypto.createHash('sha256').update(norm(title)).digest('hex').slice(0, 16)}`;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * What the content row says it is. Disney+ streams over MPEG-DASH, so the
 * row carries the DASH manifest type rather than the `text/plain` of the
 * title placeholder the importer writes as its body (the hulu.ts habit).
 */
const WATCH_MEDIA_TYPE = 'application/dash+xml';

function textContent(filename: string, body: string) {
  return { filename, mediaType: WATCH_MEDIA_TYPE, data: async () => Buffer.from(body) };
}

export class DisneyPlusFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: Stats;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      return { confidence: await this.fileConfidence(root, st) };
    }

    if (st.isDirectory()) {
      try {
        for (const name of await readdir(root)) {
          if (path.extname(name).toLowerCase() !== '.pdf') {
            continue;
          }

          const fpath = path.join(root, name);
          let child: Stats;
          try {
            child = await stat(fpath);
          } catch {
            continue;
          }

          const confidence = await this.fileConfidence(fpath, child);
          if (confidence > 0) {
            return { confidence };
          }
        }
      } catch {
        /* unreadable directory: no claim */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  /**
   * A PDF is claimed on its cover text, never on its name alone (the
   * registry's lesson: a name-only claim eventually claims someone else's
   * file). The `<id>_Final.pdf` name corroborates to 0.9; any other PDF
   * whose first pages read as the report gets 0.85.
   *
   * Without pdftotext nothing can be read, and a silent 0 would make the
   * report look unrecognised rather than the host misconfigured — so the
   * canonical name alone still claims, weakly, and the import then fails
   * with the missing-binary message where the user can see it.
   */
  private async fileConfidence(fpath: string, st: Stats): Promise<number> {
    const base = path.basename(fpath);
    if (path.extname(base).toLowerCase() !== '.pdf' || st.size > MAX_REPORT_BYTES) {
      return 0;
    }

    const named = FILENAME_RE.test(base);
    const cover = await pdfToLayoutText(fpath, { lastPage: 2 });
    if (cover == null) {
      return named && pdftotextKnownMissing() ? 0.5 : 0;
    }

    if (!COVER_RE.test(cover)) {
      return 0;
    }

    return named ? 0.9 : 0.85;
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let st: Stats;
    try {
      st = await stat(root);
    } catch {
      return;
    }

    if (st.isFile()) {
      await this.processFile(root, params);

      return;
    }

    if (!st.isDirectory()) {
      return;
    }

    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }

    for (const name of names) {
      if (path.extname(name).toLowerCase() !== '.pdf') {
        continue;
      }

      const fpath = path.join(root, name);
      let child: Stats;
      try {
        child = await stat(fpath);
      } catch {
        continue;
      }

      if ((await this.fileConfidence(fpath, child)) > 0) {
        await this.processFile(fpath, params);
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    const tsv = await pdfToTsvText(fpath);
    if (tsv == null) {
      const reason = pdftotextKnownMissing()
        ? new PdftotextMissingError('the Disney report').message
        : 'pdftotext could not read the file';
      params.log?.('error', `Failed to read ${base}`, { error: reason });

      return;
    }

    const report = parseDisneyReport(tsv);
    const { columns } = report.titlesWatched;
    if (columns.length === 0) {
      params.log?.('warn', `No "Titles Watched" table in ${base}; nothing to import`, { file: base });

      return;
    }

    for (const required of ['Date', 'Program']) {
      if (!columns.includes(required)) {
        params.log?.('error', `"Titles Watched" table in ${base} has no ${required} column`, { columns });

        return;
      }
    }

    this.emit(report, params);
  }

  /** Exposed for tests: everything below the PDF read. */
  emit(report: DisneyReport, params: ImportParams): void {
    const occurrences = new Occurrences();
    for (const row of report.titlesWatched.rows) {
      const program = (row['Program'] ?? '').replace(/\s+/g, ' ').trim();
      if (!program) {
        params.pipeline.drop?.('no_title', 'titles watched row without a program');
        continue;
      }

      const { series, season } = splitSeasonCell(row['Season']);
      const title = composeWatchTitle(program, series, season);
      const profile = (row['Profile'] ?? '').trim();
      const service = serviceName(row['Service'] ?? '');
      const when = (row['Date'] ?? '').trim();
      const ts = parseDisneyDate(when);
      if (when && !ts) {
        params.log?.('warn', 'Unparseable watch date, importing as undated', { when, title });
      }

      // Disney's own column names, not `Series`/`Episode`: the push layer's
      // titleFor (push/canonical.ts) reads an `Episode` key as a podcast
      // episode and titles the event with it alone, ahead of `Title`. The
      // composed Title is what the timeline and the Wikidata resolver
      // (embed/streamingTitle.ts) both want.
      const metadata = {
        Title: title,
        URI: titleUri(title),
        SeriesName: series || undefined,
        Season: season || undefined,
        EpisodeName: series ? program : undefined,
        Profile: profile || undefined,
        Service: service,
        Source: service,
      };

      if (!ts) {
        // Watched, date unknown: content alone, never an event wearing the
        // import date (the hulu.ts rule).
        params.pipeline.push({
          item: {
            id: occurrences.id(`disney_plus:watched:${norm(profile)}:${norm(title)}`),
            classification: 'saved_media',
            content: textContent('watched.txt', title),
            metadata: { ...metadata, Kind: 'watched' },
          },
        } satisfies Graph);
        continue;
      }

      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      params.pipeline.push({
        item: {
          // Content-derived, not position-derived: the report lists newest
          // first, so positions shift between exports. The occurrence counter
          // only tells byte-identical rows apart (and the report has them:
          // the same title twice on one day under one profile).
          id: occurrences.id(`disney_plus:watch:${when}:${profile}:${title}`),
          classification: 'watch',
          timestamp: ts,
          content: textContent('watch.txt', title),
          metadata,
        },
      } satisfies Graph);
    }
  }
}

registerDataSource({
  name: 'disney_plus',
  title: 'Disney+',
  icon: '',
  description:
    'Titles watched on Disney+ and ESPN+ from the PDF a Disney "Data Subject Access Request" returns ' +
    '(<request id>_Final.pdf). Needs pdftotext (poppler-utils) on the host.',
  newFileImporter: () => new DisneyPlusFileImporter(),
});
