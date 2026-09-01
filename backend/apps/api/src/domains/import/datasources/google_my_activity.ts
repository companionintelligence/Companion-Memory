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
import { createHash } from 'node:crypto';
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

// Sentinel for the (rare) entry whose trailing timestamp didn't parse — kept
// distinct from any real ISO string so it can never collide with one.
const NO_TS_SENTINEL = '(no-timestamp)';

// A short, content-derived fingerprint for one activity entry: stable across
// re-exports regardless of where the entry now sits in the file (see the
// call site in pushEntry for why that matters), yet still distinguishes
// entries that merely share a product. 10 hex chars (40 bits) is well past
// the collision risk for one person's activity history in one product file.
function entryFingerprint(ts: Date | undefined, title: string, url: string | undefined): string {
  const hash = createHash('sha1');
  hash.update(ts?.toISOString() ?? NO_TS_SENTINEL);
  hash.update('\0');
  hash.update(title);
  hash.update('\0');
  hash.update(url ?? '');

  return hash.digest('hex').slice(0, 10);
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
    // Per-file parse order. NOT used as (part of) pushEntry's id — see the
    // comment there for why a positional id silently loses data on re-export.
    // Still passed to pushYouTube, whose activityId() only falls back to it
    // in the degenerate case where an entry has neither a url nor a ts.
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
        // Content-derived, NOT positional: `index` is this entry's position
        // within a single parse of one file, and MyActivity.html is
        // newest-first. On a later re-export of a GROWING account, new
        // activity is prepended, shifting every existing entry to a higher
        // position — an id keyed on position alone (the previous scheme)
        // would then compute the id an OLD entry held last time for whatever
        // entry now happens to sit at position 0. hashItem() short-circuits
        // to item.id when present (staging/identity.ts), so that collision
        // makes the push logic (a) treat the genuinely NEW entry at position
        // 0 as an already-seen duplicate and silently drop it — for good,
        // since both destination tables are find-or-return, not
        // upsert-with-overwrite — and (b) mint a fresh, spurious id for the
        // OLD entry now sitting at that new position, duplicating it. Every
        // re-export of a growing account would lose its newest rows while
        // accumulating duplicate old ones. Hashing the (ts, title, url)
        // tuple instead means the same logical activity gets the same id
        // regardless of where it now sits in the file, so re-imports
        // correctly self-heal via upsert instead of drifting.
        id: `gactivity:${product}:${entryFingerprint(ts, title, url)}`,
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
