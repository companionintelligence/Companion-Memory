/* Evernote — notebook export (*.enex). An <en-export> XML document containing
   one or more <note> elements, each with a <title>, <created>/<updated> in
   basic ISO (YYYYMMDDThhmmssZ), zero or more <tag>, and a <content> CDATA block
   of ENML/HTML. One 'note' event per <note>.

   A note's checkboxes (<en-todo checked="true|false"/>) become "[x] " and
   "[ ] " in its text. Its <note-attributes> latitude/longitude become the
   item's location. Every <resource> (an attachment, base64 inline) is
   written to the run's media store and comes in as a media item of its own,
   dated with the note. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseStringPromise } from 'xml2js';

import { htmlToText } from './htmlToText';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams, Location } from './timeline';
import { isMediaMime, mediaItemFromFile, mimeForFile, textContent, timeframeContains } from './timeline';

// xml2js (default explicitArray: true) wraps every child in an array. An
// element with attributes comes back as { _: text, $: attributes }; an empty
// one comes back as ''.
interface EnexResource {
  data?: Array<string | { _?: string }>;
  mime?: string[];
  'resource-attributes'?: Array<{ 'file-name'?: string[] } | string>;
}
interface EnexNote {
  title?: string[];
  created?: string[];
  updated?: string[];
  content?: string[];
  tag?: string[];
  'note-attributes'?: Array<{ latitude?: string[]; longitude?: string[] } | string>;
  resource?: EnexResource[];
}

/** Common attachment types, for a resource whose file name has no extension. */
const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

/** ENML checkboxes as text: `[x] ` for a ticked one, `[ ] ` otherwise. */
function checkboxesAsText(enml: string): string {
  return enml.replace(/<en-todo\b([^>]*?)\/?>(?:\s*<\/en-todo>)?/gi, (_m, attrs: string) =>
    /\bchecked\s*=\s*["']true["']/i.test(attrs) ? '[x] ' : '[ ] ',
  );
}

/** The note's geotag, when it has a usable one. */
function noteLocation(note: EnexNote): Location | undefined {
  const attrs = note['note-attributes']?.[0];
  if (!attrs || typeof attrs !== 'object') {
    return undefined;
  }

  // An empty <latitude/> is no coordinate, not 0 (Number('') is 0).
  const coordinate = (v: string[] | undefined): number => Number(firstString(v)?.trim() || NaN);
  const latitude = coordinate(attrs.latitude);
  const longitude = coordinate(attrs.longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return undefined;
  }

  // Evernote writes 0,0 for "no location" on some clients.
  return latitude === 0 && longitude === 0 ? undefined : { latitude, longitude };
}

interface EnexExport {
  'en-export'?: { note?: EnexNote[] };
}

// Parse Evernote's basic ISO timestamp "YYYYMMDDThhmmssZ" into a Date.
function parseEnexDate(raw: string | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw.trim());
  if (!m) {
    const d = new Date(raw.trim());

    return isNaN(d.getTime()) ? undefined : d;
  }

  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);

  return isNaN(d.getTime()) ? undefined : d;
}

function firstString(v: string[] | undefined): string | undefined {
  if (!v || v.length === 0) {
    return undefined;
  }

  const s = v[0];

  return typeof s === 'string' ? s : undefined;
}

// Quick header sniff: is this an .enex/en-export XML document?
function looksLikeEnex(text: string): boolean {
  let head = text;
  if (head.charCodeAt(0) === 0xfeff) {
    head = head.slice(1);
  }

  head = head.slice(0, 4096);
  const trimmed = head.replace(/^\s+/, '');
  if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<en-export')) {
    return false;
  }

  return head.includes('<en-export');
}

async function sniffFile(fpath: string): Promise<boolean> {
  const head = await readHead(fpath);

  return head != null && looksLikeEnex(head);
}

export class EvernoteFileImporter implements FileImporter {
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
      if (path.extname(base) === '.enex') {
        return { confidence: 0.95 };
      }

      // Some exports use a different extension but the same XML body.
      if (await sniffFile(root)) {
        return { confidence: 0.9 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        for (const name of names) {
          if (path.extname(name).toLowerCase() === '.enex') {
            if (await sniffFile(path.join(root, name))) {
              return { confidence: 0.95 };
            }

            return { confidence: 0.9 };
          }
        }

        // Recurse one level for nested exports.
        for (const name of names) {
          const sub = path.join(root, name);
          let subStat: fs.Stats;
          try {
            subStat = await stat(sub);
          } catch {
            continue;
          }

          if (!subStat.isDirectory()) {
            continue;
          }

          try {
            const subNames = await readdir(sub);
            for (const sn of subNames) {
              if (path.extname(sn).toLowerCase() === '.enex') {
                if (await sniffFile(path.join(sub, sn))) {
                  return { confidence: 0.95 };
                }

                return { confidence: 0.9 };
              }
            }
          } catch {
            /* ignore */
          }
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

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    const files: string[] = [];
    if (stat.isFile()) {
      files.push(root);
    } else if (stat.isDirectory()) {
      this.collectEnexFiles(root, files, 0);
    }

    for (const fpath of files) {
      await this.processFile(fpath, params);
    }
  }

  private collectEnexFiles(dir: string, out: string[], depth: number): void {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      const full = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }

      if (st.isFile()) {
        if (path.extname(name).toLowerCase() === '.enex') {
          out.push(full);
        }
      } else if (st.isDirectory() && depth < 2) {
        this.collectEnexFiles(full, out, depth + 1);
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

    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    let parsed: EnexExport;
    try {
      parsed = (await parseStringPromise(raw)) as EnexExport;
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    const notes = parsed?.['en-export']?.note;
    if (!Array.isArray(notes)) {
      return;
    }

    for (const note of notes) {
      try {
        this.pushNote(note, params);
      } catch (e) {
        params.log?.('error', `Failed to import a note in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushNote(note: EnexNote, params: ImportParams): void {
    if (!note || typeof note !== 'object') {
      return;
    }

    const ts = parseEnexDate(firstString(note.created));
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const title = firstString(note.title)?.trim() || undefined;
    const tags = Array.isArray(note.tag)
      ? note.tag.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
      : [];

    const rawContent = firstString(note.content) || '';
    const text = htmlToText(checkboxesAsText(rawContent)) || title || '';

    params.pipeline.push({
      item: {
        id:
          'evernote:' +
          crypto
            .createHash('sha1')
            .update(`${title ?? ''}\0${firstString(note.created) ?? ''}\0${rawContent}`)
            .digest('hex'),
        classification: 'note',
        timestamp: ts,
        location: noteLocation(note),
        content: textContent('note.txt', text),
        metadata: {
          Title: title,
          Tags: tags.length > 0 ? tags : undefined,
          Updated: parseEnexDate(firstString(note.updated))?.toISOString(),
          Source: 'Evernote',
          // Plain-text note body. A `note` routes to `content` only, and that
          // row's `text` is read from metadata by `descriptionFor` — the content
          // blob attached above never reaches the push path.
          Text: text,
        },
      },
    });

    for (const resource of note.resource ?? []) {
      try {
        this.pushResource(resource, title, ts, params);
      } catch (e) {
        params.log?.('error', 'Failed to import an Evernote attachment', { error: (e as Error).message });
      }
    }
  }

  /**
   * One attachment: its base64 bytes go to the run's media store under a name
   * built from their hash (the export's own file name is untrusted and only
   * ever shown). A media item points at them.
   */
  private pushResource(
    resource: EnexResource,
    noteTitle: string | undefined,
    ts: Date | undefined,
    params: ImportParams,
  ): void {
    const raw = resource.data?.[0];
    const b64 = typeof raw === 'string' ? raw : raw?._;
    const bytes = b64 ? Buffer.from(b64.replace(/\s+/g, ''), 'base64') : undefined;
    if (!bytes?.length) {
      params.pipeline.drop?.('media_asset_missing', noteTitle);

      return;
    }

    const attrs = resource['resource-attributes']?.[0];
    const shownName = path
      .basename(
        ((attrs && typeof attrs === 'object' && firstString(attrs['file-name'])) || '').replace(/\\/g, '/'),
      )
      // eslint-disable-next-line no-control-regex -- strip control characters from a display name
      .replace(/[\u0000-\u001f]/g, '')
      .trim();
    const mime = firstString(resource.mime)?.trim().toLowerCase();
    const nameExt = /^\.[a-z0-9]{1,8}$/i.test(path.extname(shownName))
      ? path.extname(shownName).slice(1)
      : undefined;
    const ext = (nameExt ?? (mime ? EXTENSION_FOR_MIME[mime] : undefined) ?? 'bin').toLowerCase();
    const hash = crypto.createHash('md5').update(bytes).digest('hex');

    const dir = params.mediaStoreDir ?? os.tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    const fpath = path.join(dir, `evernote-${hash}.${ext}`);
    if (!fs.existsSync(fpath)) {
      fs.writeFileSync(fpath, bytes);
    }

    const item = mediaItemFromFile(fpath);
    const filename = shownName || `attachment.${ext}`;
    // The declared type, unless it is a catch-all (application/octet-stream)
    // that the file's extension improves on.
    const fromName = item.content.mediaType || mimeForFile(filename);
    const mediaType = mime && mime !== 'application/octet-stream' ? mime : fromName || mime;
    params.pipeline.push({
      item: {
        ...item,
        id: `evernote:resource:${hash}`,
        classification: isMediaMime(mediaType) ? 'media' : 'file',
        timestamp: ts,
        content: { ...item.content, filename, mediaType },
        metadata: { Title: filename, Note: noteTitle, Source: 'Evernote' },
      },
    });
  }
}

registerDataSource({
  name: 'evernote',
  title: 'Evernote',
  icon: '',
  description: 'Notes from an Evernote .enex export.',
  newFileImporter: () => new EvernoteFileImporter(),
});
