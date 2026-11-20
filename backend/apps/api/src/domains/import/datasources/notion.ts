/* Notion — "Export → Markdown & CSV" output.
   Produces a directory tree of "*.md" files (one per page; names often end with
   a 32-hex id) plus optional "*.csv" for databases. Each .md page begins with a
   "# Title" heading. Notion markdown does not embed a reliable created date, so
   the timestamp is omitted unless a "Created: <date>" property line appears near
   the top of the body. One 'note' event per .md file.

   A subpage sits in a folder named like its parent page (`<Title> <id>/`), so
   the export is as deep as its deepest page. The import walks all of it.
   Files embedded in a page (images, PDFs) sit in that page's folder and come
   in as media. A database exports as `<Name> <id>.csv` (plus an `_all.csv`
   copy) with one page per row in its folder; those row pages carry the same
   properties, so the CSVs are counted as represented by them, not imported.
*/
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { extractMediaMetadata } from '@ci/common/media/exif';

import { listFiles } from './fsWalk';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { mediaItemFromFile, textContent, timeframeContains } from './timeline';

/**
 * Notion's exporter names every page `<Title> <32-hex-id>.md` — that suffix is
 * the signature. A bare `.md` used to score 0.6, which is how a readme inside
 * an Amazon archive became "Notion data"; markdown with no id is anyone's.
 */
const NOTION_MD_RE = /\s[0-9a-f]{32}\.md$/i;

function isNotionMarkdownName(name: string): boolean {
  return NOTION_MD_RE.test(name);
}

/** A page's (or database's) own folder: `<Title> <32-hex id>`. */
const NOTION_FOLDER_RE = /\s[0-9a-f]{32}$/i;
/** A database export: `<Name> <32-hex id>.csv`, and the `_all.csv` copy newer exports add. */
const NOTION_CSV_RE = /\s[0-9a-f]{32}(_all)?\.csv$/i;
/** How many folders deep a page can sit. Recognition still only looks two levels down. */
const NOTION_IMPORT_DEPTH = 32;

// Recurse a directory up to `depth` levels, returning absolute paths of Notion-named *.md files.
async function findMarkdownFiles(dir: string, depth: number, out: string[]): Promise<void> {
  out.push(...(await listFiles(dir, { maxDepth: depth, match: isNotionMarkdownName })));
}

// Strip the leading "# " of the first non-empty line to get a page title.
function extractTitle(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const m = /^#+\s+(.*)$/.exec(trimmed);

    return (m ? m[1] : trimmed).trim() || undefined;
  }

  return undefined;
}

// Look for a "Created: <date>" style property line within the first ~15 lines.
function extractCreated(text: string): Date | undefined {
  const lines = text.split(/\r?\n/);
  const limit = Math.min(lines.length, 15);
  for (let i = 0; i < limit; i++) {
    const m = /^\s*Created\s*:\s*(.+?)\s*$/i.exec(lines[i]);
    if (!m) {
      continue;
    }

    const d = new Date(m[1]);
    if (!isNaN(d.getTime())) {
      return d;
    }

    return undefined;
  }

  return undefined;
}

export class NotionFileImporter implements FileImporter {
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
      // A single exported page dropped directly — recognize modestly so a more
      // specific importer can outrank us. Only with Notion's id suffix: bare
      // markdown is anyone's.
      if (isNotionMarkdownName(path.basename(root))) {
        return { confidence: 0.6 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      const found: string[] = [];
      await findMarkdownFiles(root, 2, found);
      if (found.length > 0) {
        return { confidence: 0.65, dir_threshold: 0.7 };
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

    const files: string[] = [];
    const embedded: string[] = [];
    if (stat.isFile()) {
      if (path.extname(root).toLowerCase() === '.md') {
        files.push(root);
      }
    } else if (stat.isDirectory()) {
      for (const fpath of await listFiles(root, { maxDepth: NOTION_IMPORT_DEPTH, sorted: true })) {
        const name = path.basename(fpath);
        if (isNotionMarkdownName(name)) {
          files.push(fpath);
        } else if (NOTION_CSV_RE.test(name)) {
          // Its rows are pages of their own in the database's folder.
          params.pipeline.drop?.('notion_database_csv', name);
        } else if (NOTION_FOLDER_RE.test(path.basename(path.dirname(fpath))) && !name.startsWith('.')) {
          embedded.push(fpath);
        }
      }
    }

    for (const fpath of files) {
      try {
        await this.processFile(fpath, params);
      } catch (e) {
        params.log?.('error', `Failed to import Notion page ${path.basename(fpath)}`, {
          error: (e as Error).message,
        });
      }
    }

    for (const fpath of embedded) {
      try {
        await this.pushEmbeddedFile(fpath, params);
      } catch (e) {
        params.log?.('error', `Failed to import Notion file ${path.basename(fpath)}`, {
          error: (e as Error).message,
        });
      }
    }
  }

  /** A file embedded in a page: media (or a plain file) named after the page it sits in. */
  private async pushEmbeddedFile(fpath: string, params: ImportParams): Promise<void> {
    const folder = path.basename(path.dirname(fpath));
    const item = mediaItemFromFile(fpath);
    const media = await extractMediaMetadata(fpath, item.content.mediaType);
    if (!timeframeContains(params.timeframe, media.timestamp)) {
      return;
    }

    params.pipeline.push({
      item: {
        ...item,
        // The folder carries the page's id, so the same file in another page
        // keeps its own row.
        id: `notion:${folder}/${path.basename(fpath)}`,
        timestamp: media.timestamp,
        location: media.location,
        metadata: {
          ...media.metadata,
          Title: path.basename(fpath),
          Page: folder.replace(NOTION_FOLDER_RE, '').trim() || undefined,
          Source: 'Notion',
        },
      },
    });
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read Notion page ${path.basename(fpath)}`, {
        error: (e as Error).message,
      });

      return;
    }

    // Strip a UTF-8 BOM if present.
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    if (!raw.trim()) {
      return;
    }

    const title = extractTitle(raw);
    const ts = extractCreated(raw);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    params.pipeline.push({
      item: {
        id: 'notion:' + path.basename(fpath),
        classification: 'note',
        timestamp: ts,
        content: textContent('note.txt', raw),
        metadata: {
          Title: title || undefined,
          Source: 'Notion',
          // The page body. A `note` routes to `content` ONLY (canonical.ts
          // `destinationsFor`), and the content row's `text` comes from
          // `descriptionFor(metadata)` — nothing on the push path ever calls
          // `content.data()`. Without this key the page lands as a title and a
          // timestamp with an empty body.
          Text: raw,
        },
      },
    });
  }
}

registerDataSource({
  name: 'notion',
  title: 'Notion',
  icon: '',
  description: 'Pages from a Notion Markdown export.',
  newFileImporter: () => new NotionFileImporter(),
});
