/* Google My Activity — per-product MyActivity.html files from a Google Takeout
   "My Activity" export. One file per product (Search, Maps, YouTube, Ads,
   Assistant, Shopping, …). Each activity is an "outer-cell" whose body cell
   ("mdl-typography--body-1") holds an action verb, an optional <a href> target,
   and a trailing timestamp line, e.g.

     Visited <a href="…">Jaron Lanier's Homepage</a><br>Jun 17, 2026, 9:30:52 PM PDT<br>
     Searched for <a href="…?q=Lanier">Lanier</a><br>Jun 17, 2026, 9:30:38 PM PDT<br>
     Explored on Google Maps<br>Jun 18, 2026, 6:59:05 PM PDT<br>

   These files can be hundreds of MB, so we scan the body cells with a regex
   rather than building a DOM.

   The product is read from each entry's header cell ("mdl-typography--title"),
   falling back to the Takeout folder name only when a file has none — a
   MyActivity.html downloaded straight from myactivity.google.com sits in no
   product folder and mixes products (YouTube, YouTube Music) in one file.

   YouTube / YouTube Music entries are not generic page-views: "Watched",
   "Searched for", "Liked" and "Subscribed to" go through _youtube_activity.ts,
   attributed to the `youtube` data source, so they land exactly as the YouTube
   Takeout's own watch-history.html would (media.watch with the channel, etc.)
   and dedup against it. Verbs that module does not model (Viewed a post,
   Dismissed a shelf) keep the generic handling below. */
import fs from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { isYouTubeProduct, parseActivityCell, youtubeActivityGraph } from './_youtube_activity';
import { matchingDivCloseIndex } from './htmlBlocks';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph, Metadata } from './timeline';
import { timeframeContains } from './timeline';

// The action body cell of one activity, matched by its OPENING tag only — the
// close comes from matchingDivCloseIndex (./htmlBlocks), not a non-greedy
// `[\s\S]*?<\/div>`: some product types nest a thumbnail/icon div inside the
// body cell, and a non-greedy match stops at THAT close and truncates the
// entry, the same failure mode googlevoice.ts hit on real MMS attachments.
// The text-right variant and the caption cell carry no activity text, so the
// class match ends exactly at `body-1">` — their class attribute continues
// past this point, so they never match.
const BODY_CELL_OPEN_RE = /<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">/g;
// The header cell naming the product, immediately before each body cell.
const HEADER_TITLE = 'mdl-typography--title">';
// Header and body are adjacent in the entry; anything further back belongs to
// the previous entry.
const HEADER_LOOKBEHIND = 400;
// First <a href="…">…</a> inside a body cell — the action's primary target.
const FIRST_LINK_RE = /<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
// Trailing "Mon DD, YYYY, H:MM:SS AM/PM TZ" timestamp line.
const TIMESTAMP_RE = /([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2}\s?(?:AM|PM)\s+[A-Z]{2,5})/;

function decodeEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGoogleDate(s: string | undefined): Date | undefined {
  if (!s) {
    return undefined;
  }

  const d = new Date(s.replace(/\u00A0/g, ' ').trim());

  return isNaN(d.getTime()) ? undefined : d;
}

// Product folder name from a MyActivity.html path: …/My Activity/<Product>/MyActivity.html
function productFor(fpath: string): string {
  return path.basename(path.dirname(fpath)) || 'Activity';
}

/** The product named in the header cell just before the body cell at `at`. */
function headerProductBefore(raw: string, at: number): string | undefined {
  const start = raw.lastIndexOf(HEADER_TITLE, at);
  if (start === -1 || at - start > HEADER_LOOKBEHIND) {
    return undefined;
  }

  const from = start + HEADER_TITLE.length;
  const end = raw.indexOf('<', from);
  const name = decodeEntities(raw.slice(from, end === -1 ? from : end));

  return name || undefined;
}

async function* walkActivityFiles(root: string, depth = 0): AsyncGenerator<string> {
  if (depth > 4) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walkActivityFiles(p, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase() === 'myactivity.html') {
      yield p;
    }
  }
}

export class GoogleMyActivityFileImporter implements FileImporter {
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
      if (path.basename(root).toLowerCase() !== 'myactivity.html') {
        return { confidence: 0 };
      }

      // Confirm the body-cell signature so we don't claim arbitrary HTML.
      let fh: FileHandle | undefined;
      try {
        fh = await open(root, 'r');
        const buf = Buffer.alloc(65536);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);

        return buf.subarray(0, bytesRead).includes('mdl-typography--body-1')
          ? { confidence: 0.95 }
          : { confidence: 0 };
      } catch {
        return { confidence: 0 };
      } finally {
        if (fh !== undefined) {
          await fh.close().catch(() => {});
        }
      }
    }

    if (st.isDirectory()) {
      for await (const _ of walkActivityFiles(root)) {
        return { confidence: 0.9 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
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
      for await (const f of walkActivityFiles(root)) {
        await this.processFile(f, params);
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read MyActivity.html', {
        file: path.basename(fpath),
        error: (e as Error).message,
      });
      // How many activities this file held is unknowable once it can't be read.
      params.pipeline.drop?.('unreadable_file', path.basename(fpath));

      return;
    }

    const folderProduct = productFor(fpath);
    // index is the per-file parse order, so the stable id stays deterministic
    // across re-imports even when entries share an action, target, and second.
    let index = 0;
    // How many body cells this file actually offered the parser — the floor
    // `reconciled` checks every produced/dropped entry against.
    let total = 0;
    BODY_CELL_OPEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BODY_CELL_OPEN_RE.exec(raw)) !== null) {
      total++;
      const start = m.index + m[0].length;
      const end = matchingDivCloseIndex(raw, start);
      const cellHtml = raw.slice(start, end);
      // Resume scanning AFTER the cell, not from the regex's own default
      // (right after the opening tag): a body cell that nests another div
      // must not be re-entered and its content double-counted.
      BODY_CELL_OPEN_RE.lastIndex = end;
      // The empty text-right body cell appears once per activity; skip it.
      if (!cellHtml.trim()) {
        params.pipeline.drop?.('empty_after_parse');

        continue;
      }

      const product = headerProductBefore(raw, m.index) ?? folderProduct;
      const i = index++;
      if (isYouTubeProduct(product) && this.pushYouTube(cellHtml, i, params)) {
        continue;
      }

      this.pushEntry(cellHtml, product, i, params);
    }

    params.pipeline.consumed?.(total);
  }

  /** YouTube's own shape for the verbs _youtube_activity models; false otherwise. */
  private pushYouTube(cellHtml: string, index: number, params: ImportParams): boolean {
    const cell = parseActivityCell(cellHtml);
    if (!cell.anchors.length) {
      return false;
    }

    const g = youtubeActivityGraph(cell, { index, dataSource: 'youtube' });
    if (!g) {
      return false;
    }

    if (timeframeContains(params.timeframe, cell.ts)) {
      params.pipeline.push(g);
    }

    // Out-of-timeframe is still "handled": it must not fall through to a page-view.
    return true;
  }

  private pushEntry(cellHtml: string, product: string, index: number, params: ImportParams): void {
    // Decode first, THEN match/strip the timestamp on the decoded text: the raw
    // HTML separates the date with &nbsp;/<br>, so a raw-matched timestamp string
    // won't substring-match the whitespace-normalised decoded action.
    const decoded = decodeEntities(cellHtml);
    const tsMatch = decoded.match(TIMESTAMP_RE);
    const ts = parseGoogleDate(tsMatch?.[1]);
    if (!timeframeContains(params.timeframe, ts)) {
      params.pipeline.drop?.('outside_timeframe');

      return;
    }

    const link = cellHtml.match(FIRST_LINK_RE);
    const url = link ? decodeEntities(link[1]) : undefined;
    const linkText = link ? decodeEntities(link[2]) : undefined;

    // Full body text with the timestamp line stripped → the action phrase
    // ("Visited Jaron Lanier's Homepage", "Searched for Lanier", "Used Assistant").
    let action = decoded;
    if (tsMatch) {
      action = action.replace(tsMatch[1], '').trim();
    }

    // The leading verb phrase before the linked target (e.g. "Searched for").
    const verb = link ? decodeEntities(cellHtml.split(link[0])[0]) : action;

    let classification: string;
    let title: string;
    const metadata: Metadata = {
      Product: product,
      Action: action || undefined,
      Source: 'Google My Activity',
    };

    if (/^Searched for\b/i.test(verb) || /^Searched\b/i.test(action)) {
      classification = 'search';
      const query = linkText || action.replace(/^Searched for\s*/i, '').trim();
      title = query || action || 'Search';
      metadata.Query = query || undefined;
      metadata.Text = query || undefined;
      metadata.Title = title;
      if (url) {
        metadata.URL = url;
      }
    } else if (/^(Visited|Viewed|Watched)\b/i.test(verb) && url) {
      classification = 'page_view';
      title = linkText || action || product;
      metadata.Title = title;
      metadata.URL = url;
    } else {
      // Action-only entries with no target (e.g. "Used Assistant",
      // "Explored on Google Maps") — keep the action text as the title.
      classification = 'page_view';
      title = action || product;
      metadata.Title = title;
      if (url) {
        metadata.URL = url;
      }
    }

    const g: Graph = {
      item: {
        // Stable, deterministic per-file id; index keeps near-duplicate entries
        // distinct so they don't collapse in hashItem (shared filename + bucket).
        id: `gactivity:${product}:${index}`,
        classification,
        timestamp: ts,
        content: { filename: 'activity.txt', mediaType: 'text/plain', data: async () => Buffer.from(title) },
        metadata,
      },
    };
    params.pipeline.push(g);
  }
}

registerDataSource({
  name: 'google_my_activity',
  title: 'Google My Activity',
  icon: '',
  description:
    'Per-product activity (Search, Maps, YouTube, Assistant, …) from a Google Takeout My Activity export.',
  newFileImporter: () => new GoogleMyActivityFileImporter(),
});
