/* Kindle — My Clippings.txt highlights and notes from a Kindle device. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, EntityAttribute } from './timeline';
import { timeframeContains } from './timeline';

const SEPARATOR = '==========';

interface Clip {
  bookTitle: string;
  author: string;
  clipType: string;
  page?: string;
  location?: string;
  addedOn?: Date;
  text: string;
}

function parseClip(block: string): Clip | null {
  const nonEmpty = block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (nonEmpty.length < 2) {
    return null;
  }

  const titleLine = nonEmpty[0];
  // "Book Title (Author Name)" — author may be absent
  const authorMatch = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(titleLine);
  const bookTitle = authorMatch ? authorMatch[1].trim() : titleLine.trim();
  const author = authorMatch ? authorMatch[2].trim() : '';

  const metaLine = nonEmpty[1];
  if (!metaLine.startsWith('-')) {
    return null;
  }

  const typeMatch = /Your (\w+)/.exec(metaLine);
  const clipType = typeMatch ? typeMatch[1] : 'Unknown';
  const pageMatch = /page (\S+)/.exec(metaLine);
  const locMatch = /[Ll]ocation (\S+)/.exec(metaLine);
  const dateMatch = /Added on (.+)$/.exec(metaLine);

  let addedOn: Date | undefined;
  if (dateMatch) {
    addedOn = new Date(dateMatch[1].trim());
    if (isNaN(addedOn.getTime())) {
      addedOn = undefined;
    }
  }

  // Everything after the meta line is the clip text
  const textLines = nonEmpty.slice(2);
  const text = textLines.join('\n').trim();

  return { bookTitle, author, clipType, page: pageMatch?.[1], location: locMatch?.[1], addedOn, text };
}

export class KindleFileImporter implements FileImporter {
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
      if (base === 'my clippings.txt') {
        return { confidence: 0.97 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = (await readdir(root)).map((n) => n.toLowerCase());
        if (names.includes('my clippings.txt')) {
          return { confidence: 0.97 };
        }
      } catch {
        /* ignore */
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

    let clippingsPath = root;
    try {
      if (fs.statSync(root).isDirectory()) {
        const names = fs.readdirSync(root);
        const found = names.find((n) => n.toLowerCase() === 'my clippings.txt');
        if (!found) {
          return;
        }

        clippingsPath = path.join(root, found);
      }
    } catch {
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(clippingsPath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read My Clippings.txt', { error: (e as Error).message });

      return;
    }

    // Remove UTF-8 BOM if present
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    for (const block of raw.split(SEPARATOR)) {
      const trimmed = block.trim();
      if (!trimmed) {
        continue;
      }

      const clip = parseClip(trimmed);
      if (!clip) {
        params.pipeline.drop?.('malformed_clip');
        continue;
      }

      if (!timeframeContains(params.timeframe, clip.addedOn)) {
        continue;
      }

      const bookAttrs: EntityAttribute[] = [];
      if (clip.author) {
        bookAttrs.push({ name: 'author', value: clip.author, identity: false });
      }

      const bookEntity = { type: 'book', name: clip.bookTitle, attributes: bookAttrs };

      const naturalKey = [clip.bookTitle, clip.author, clip.location ?? clip.page ?? '', clip.text].join(
        '\0',
      );
      const id = crypto.createHash('sha1').update('kindle').update('\0').update(naturalKey).digest('hex');

      params.pipeline.push({
        item: {
          id,
          classification: 'annotation',
          timestamp: clip.addedOn,
          content: {
            filename: 'clipping.txt',
            mediaType: 'text/plain',
            data: async () => Buffer.from(clip.text),
          },
          metadata: {
            'Clip Type': clip.clipType,
            Book: clip.bookTitle,
            Author: clip.author || undefined,
            Page: clip.page || undefined,
            Location: clip.location || undefined,
            // The highlighted passage itself. `reading.annotation` routes to
            // `content` only, and that row's `text` comes from
            // `descriptionFor(metadata)`, which reads `Highlight`. It also
            // gives `titleFor` the excerpt it needs to tell two clippings from
            // the same book apart ("<book> — <excerpt>").
            Highlight: clip.text,
          },
        },
        entity: bookEntity,
        edges: [{ relation: 'from', to: { entity: bookEntity } }],
      });
    }
  }
}

registerDataSource({
  name: 'kindle',
  title: 'Kindle highlights',
  icon: '',
  description: 'Highlights and notes from a Kindle device\'s "My Clippings.txt".',
  newFileImporter: () => new KindleFileImporter(),
});
