/* Hulu — the "Personal Information Report" PDF a Right-to-Know request
   returns (rtk-report-<digits>.pdf).

   Hulu ships no machine-readable export: the whole report is one PDF of
   tables. Text comes out of it with poppler's `pdftotext -layout` (a system
   binary, the way the import domain already shells out to `unzip` and
   `ffprobe`), and `_hulu_report.ts` reads the layout back into tables.

   Only Watch History is imported:
   - dated rows   → 'watch' events (kind media.watch), one per play, the
                    title's content row shared across plays via metadata.URI —
                    the netflix.ts / prime_video.ts pattern.
   - undated rows → 'saved_media' (content only). Older history has no "Last
                    Played At"; a media.watch event without a time would land
                    on the timeline wearing the import date, so these are kept
                    as things watched, not occurrences.

   Deliberately not imported: Personal Details (the account holder is the
   appliance owner), Profiles, Plan Details, Subscription History, Devices And
   Logins, Tastes and Onboarding, and the advertising lists. The tastes are
   Hulu's onboarding suggestions rather than anything the household picked,
   and the plan / billing / device tables are internal bookkeeping whose
   timestamps mix unstated timezones — noise on a timeline at best, wrong at
   worst. See the section map in `_hulu_report.ts`. */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { cellValue, parseHuluReport, parseHuluTimestamp, type HuluReport } from './_hulu_report';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { Graph, ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const execFileAsync = promisify(execFile);

const FILENAME_RE = /^rtk-report-\d+\.pdf$/i;

/** The report is ~4 KB a page; a PDF past this is not one. */
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/** First-page text that names the document: the cover blurb mentions the account. */
const COVER_RE = /personal information report[\s\S]{0,600}your hulu account/i;

/**
 * Once pdftotext is missing on this host we don't keep paying the spawn cost
 * for every PDF a recognition scan walks past. Cached for the process.
 */
let pdftotextAvailable: boolean | undefined;

export class PdftotextMissingError extends Error {
  constructor() {
    super(
      'pdftotext (poppler-utils) is not installed; the Hulu report is a PDF and cannot be read without it',
    );
    this.name = 'PdftotextMissingError';
  }
}

/**
 * Run pdftotext over the file. `-layout` keeps the page geometry the table
 * parser depends on; `-l 1` limits a recognition sniff to the cover page.
 * Returns null when the binary is absent (memoised) or the file is not a PDF
 * poppler can open.
 */
export async function pdfToLayoutText(
  fpath: string,
  opts: { firstPageOnly?: boolean } = {},
): Promise<string | null> {
  if (pdftotextAvailable === false) {
    return null;
  }

  const args = ['-layout', '-enc', 'UTF-8', '-q'];
  if (opts.firstPageOnly) {
    args.push('-l', '1');
  }

  args.push(fpath, '-');

  try {
    const { stdout } = await execFileAsync('pdftotext', args, {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    pdftotextAvailable = true;

    return stdout;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      pdftotextAvailable = false;
    }

    return null;
  }
}

/** For tests: forget the cached verdict on pdftotext's presence. */
export function resetPdftotextProbe(): void {
  pdftotextAvailable = undefined;
}

/**
 * Stable per-title identity for the content row: case/whitespace-insensitive
 * hash of the composed title, so every play of one episode (and every
 * re-export) lands on ONE content row while each play stays its own event.
 * sha256 like netflix.ts, so Postgres can recompute it by hand.
 */
function titleUri(title: string): string {
  const norm = title.replace(/\s+/g, ' ').trim().toLowerCase();

  return `hulu:title:${crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16)}`;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Netflix's title shape, "Series: Season N: Episode", so the two services'
 * watch rows read alike. Movies and live events have no series and become the
 * bare name; a season of 0 (a news broadcast) or N/A is left out.
 */
export function composeWatchTitle(episode: string, series: string, season: string): string {
  if (!series) {
    return episode;
  }

  const parts = [series];
  if (/^[1-9]\d*$/.test(season)) {
    parts.push(`Season ${season}`);
  }

  parts.push(episode);

  return parts.join(': ');
}

/**
 * What the content row says it is. Hulu streams over MPEG-DASH, so the row
 * carries the DASH manifest type rather than the `text/plain` of the title
 * placeholder the importer writes as its body (the netflix.ts/letterboxd.ts
 * habit). It is a statement about the thing watched, not about those bytes.
 */
const WATCH_MEDIA_TYPE = 'application/dash+xml';

function textContent(filename: string, body: string) {
  return { filename, mediaType: WATCH_MEDIA_TYPE, data: async () => Buffer.from(body) };
}

/** Distinct, stable ids for rows that are byte-identical within one report. */
class Occurrences {
  private readonly seen = new Map<string, number>();

  id(base: string): string {
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);

    return n === 0 ? base : `${base}:${n}`;
  }
}

export class HuluFileImporter implements FileImporter {
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
   * file). The canonical `rtk-report-<n>.pdf` name corroborates to 0.9; any
   * other small PDF whose cover reads as the report gets 0.85.
   *
   * Without pdftotext nothing can be read, and a silent 0 would make the
   * report look unrecognised rather than the host misconfigured — so the
   * canonical name alone still claims, weakly, and the import then fails with
   * the missing-binary message where the user can see it.
   */
  private async fileConfidence(fpath: string, st: Stats): Promise<number> {
    const base = path.basename(fpath);
    if (path.extname(base).toLowerCase() !== '.pdf' || st.size > MAX_REPORT_BYTES) {
      return 0;
    }

    const named = FILENAME_RE.test(base);
    const cover = await pdfToLayoutText(fpath, { firstPageOnly: true });
    if (cover == null) {
      return named && pdftotextAvailable === false ? 0.5 : 0;
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
    const text = await pdfToLayoutText(fpath);
    if (text == null) {
      const reason =
        pdftotextAvailable === false
          ? new PdftotextMissingError().message
          : 'pdftotext could not read the file';
      params.log?.('error', `Failed to read ${base}`, { error: reason });

      return;
    }

    const report = parseHuluReport(text);
    for (const title of report.unknownSections) {
      params.log?.('warn', `Unrecognised section in ${base}, skipped`, { section: title });
    }

    this.emit(report, params);
  }

  /** Exposed for tests: everything below the PDF read. */
  emit(report: HuluReport, params: ImportParams): void {
    this.emitWatchHistory(report, params, new Occurrences());
  }

  private emitWatchHistory(report: HuluReport, params: ImportParams, occurrences: Occurrences): void {
    for (const row of report.watchHistory.rows) {
      const episode = cellValue(row['Episode Name']);
      const series = cellValue(row['Series Name']);
      const season = cellValue(row['Season']);
      if (!episode && !series) {
        params.pipeline.drop?.('no_title', 'watch history row without an episode or series name');
        continue;
      }

      const title = composeWatchTitle(episode || series, episode ? series : '', season);
      const when = cellValue(row['Last Played At']);
      const ts = parseHuluTimestamp(when);
      if (when && !ts) {
        params.log?.('warn', 'Unparseable watch time, importing as undated', { when, title });
      }

      // Hulu's own column names, not `Series`/`Episode`: the push layer's
      // titleFor (push/canonical.ts) reads an `Episode` key as a podcast
      // episode and titles the event with it alone, ahead of `Title`. The
      // composed Title is what the timeline and the Wikidata resolver
      // (embed/streamingTitle.ts) both want.
      const metadata = {
        Title: title,
        URI: titleUri(title),
        SeriesName: series || undefined,
        Season: season || undefined,
        EpisodeName: episode || undefined,
        Source: 'Hulu',
      };

      if (!ts) {
        // Watched, date unknown: content alone (see the file comment).
        params.pipeline.push({
          item: {
            id: occurrences.id(`hulu:watched:${norm(title)}`),
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
          // Content-derived, not position-derived: Hulu lists newest first, so
          // positions shift between exports. The occurrence counter only tells
          // byte-identical rows apart.
          id: occurrences.id(`hulu:watch:${when}:${title}`),
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
  name: 'hulu',
  title: 'Hulu',
  icon: '',
  description:
    'Watch history from the Hulu "Personal Information Report" PDF (rtk-report-<n>.pdf) a privacy / ' +
    'Right-to-Know request returns. Needs pdftotext (poppler-utils) on the host.',
  newFileImporter: () => new HuluFileImporter(),
});
