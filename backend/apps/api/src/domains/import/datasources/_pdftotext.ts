/* poppler's `pdftotext`, for the importers whose export is a PDF and nothing
   else (hulu.ts, disney_plus.ts). A system binary, the way the import domain
   already shells out to `unzip` and `ffprobe`.

   Two renderings are used:
   - `-layout` keeps the page geometry as whitespace; the Hulu table parser
     reads columns back from it, and both importers sniff a cover page with it.
   - `-tsv` lists every word with its position in points. The Disney report
     needs it: its table's columns drift by several character cells within
     one page of `-layout` text, and a cell that fills its column is separated
     from the next by a single space, which no whitespace rule can split. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Once pdftotext is missing on this host we don't keep paying the spawn cost
 * for every PDF a recognition scan walks past. Cached for the process.
 */
let pdftotextAvailable: boolean | undefined;

export class PdftotextMissingError extends Error {
  constructor(what = 'the report') {
    super(`pdftotext (poppler-utils) is not installed; ${what} is a PDF and cannot be read without it`);
    this.name = 'PdftotextMissingError';
  }
}

/** True once a spawn has failed with ENOENT; false or unknown otherwise. */
export function pdftotextKnownMissing(): boolean {
  return pdftotextAvailable === false;
}

/** For tests: forget the cached verdict on pdftotext's presence. */
export function resetPdftotextProbe(): void {
  pdftotextAvailable = undefined;
}

async function run(fpath: string, args: string[]): Promise<string | null> {
  if (pdftotextAvailable === false) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('pdftotext', [...args, fpath, '-'], {
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

/**
 * Run pdftotext over the file. `-layout` keeps the page geometry the table
 * parser depends on; `firstPageOnly` / `lastPage` limit a recognition sniff
 * to the cover. Returns null when the binary is absent (memoised) or the file
 * is not a PDF poppler can open.
 */
export async function pdfToLayoutText(
  fpath: string,
  opts: { firstPageOnly?: boolean; lastPage?: number } = {},
): Promise<string | null> {
  const args = ['-layout', '-enc', 'UTF-8', '-q'];
  const last = opts.firstPageOnly ? 1 : opts.lastPage;
  if (last != null) {
    args.push('-l', String(last));
  }

  return run(fpath, args);
}

/**
 * pdftotext's `-tsv` rendering: one tab-separated row per word (level 5),
 * with `left`/`top`/`width`/`height` in points from the page's top-left, and
 * marker rows for pages, flows, blocks and lines. Same null contract as
 * `pdfToLayoutText`.
 */
export async function pdfToTsvText(fpath: string): Promise<string | null> {
  return run(fpath, ['-tsv', '-enc', 'UTF-8', '-q']);
}
