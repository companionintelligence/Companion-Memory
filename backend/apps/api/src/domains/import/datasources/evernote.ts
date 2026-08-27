/* Evernote — notebook export (*.enex). An <en-export> XML document containing
   one or more <note> elements, each with a <title>, <created>/<updated> in
   basic ISO (YYYYMMDDThhmmssZ), zero or more <tag>, and a <content> CDATA block
   of ENML/HTML. One 'note' event per <note>. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { parseStringPromise } from 'xml2js';

import { htmlToText } from './htmlToText';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

// xml2js (default explicitArray: true) wraps every child in an array.
interface EnexNote {
  title?: string[];
  created?: string[];
  updated?: string[];
  content?: string[];
  tag?: string[];
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
  let fh: FileHandle | undefined;
  try {
    fh = await open(fpath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);

    return looksLikeEnex(buf.toString('utf8', 0, bytesRead));
  } catch {
    return false;
  } finally {
    if (fh !== undefined) {
      await fh.close().catch(() => {});
    }
  }
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
    const text = htmlToText(rawContent) || title || '';

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
        content: { filename: 'note.txt', mediaType: 'text/plain', data: async () => Buffer.from(text) },
        metadata: {
          Title: title,
          Tags: tags.length > 0 ? tags : undefined,
          Source: 'Evernote',
        },
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
