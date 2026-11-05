/* Google Keep — Takeout "Keep/" export.
   One JSON per note: { title?, textContent?, listContent?:[{text,isChecked}],
   annotations:[{title,url}], labels?:[{name}], isArchived, isTrashed, color,
   userEditedTimestampUsec, createdTimestampUsec, attachments }.
   One 'note' event per non-trashed note. Timestamps are MICROSECONDS since the
   Unix epoch. Trashed notes are skipped.
*/
import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

interface KeepListItem {
  text?: string;
  isChecked?: boolean;
}
interface KeepAnnotation {
  title?: string;
  url?: string;
  description?: string;
  source?: string;
}
interface KeepLabel {
  name?: string;
}
interface KeepNote {
  title?: string;
  textContent?: string;
  listContent?: KeepListItem[];
  annotations?: KeepAnnotation[];
  labels?: KeepLabel[];
  isArchived?: boolean;
  isTrashed?: boolean;
  isPinned?: boolean;
  color?: string;
  userEditedTimestampUsec?: number;
  createdTimestampUsec?: number;
}

// Takeout stamps note edit/create times in microseconds since the Unix epoch.
function usecToDate(usec: number | undefined): Date | undefined {
  if (typeof usec !== 'number' || usec <= 0) {
    return undefined;
  }

  const d = new Date(Math.floor(usec / 1000));

  return isNaN(d.getTime()) ? undefined : d;
}

// Join a checklist into plain text, marking checked items, so list-only notes
// (no textContent) still carry searchable body text.
function listToText(list: KeepListItem[] | undefined): string {
  if (!list || !list.length) {
    return '';
  }

  return list.map((li) => `${li.isChecked ? '[x]' : '[ ]'} ${(li.text ?? '').trim()}`).join('\n');
}

function firstLine(s: string | undefined): string | undefined {
  if (!s) {
    return undefined;
  }

  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t) {
      return t.length > 80 ? `${t.slice(0, 79)}…` : t;
    }
  }

  return undefined;
}

// Join annotation title/description/url into readable text so annotation-only
// notes (e.g. a WEBLINK or shared-place chip with no plain-text body) still
// carry their real content instead of importing as an empty placeholder.
function annotationsToText(annotations: KeepAnnotation[] | undefined): string {
  if (!annotations || !annotations.length) {
    return '';
  }

  return annotations
    .map((a) => [a.title?.trim(), a.description?.trim(), a.url?.trim()].filter(Boolean).join(' — '))
    .filter(Boolean)
    .join('\n');
}

export class GoogleKeepFileImporter implements FileImporter {
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
      return path.extname(root).toLowerCase() === '.json' && (await this.looksLikeNote(root))
        ? { confidence: 0.9 }
        : { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        // A Keep export ships Labels.txt alongside the note JSONs — a strong tell.
        const hasLabels = names.some((n) => n.toLowerCase() === 'labels.txt');
        for (const n of names) {
          if (path.extname(n).toLowerCase() !== '.json') {
            continue;
          }

          if (await this.looksLikeNote(path.join(root, n))) {
            return { confidence: hasLabels ? 0.95 : 0.85, dir_threshold: 0.7 };
          }
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  // A Keep note JSON has the signature timestamp + a note-shaped key.
  private async looksLikeNote(fpath: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(fpath, 'utf8');
    } catch {
      return false;
    }

    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return false;
    }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return false;
    }

    const o = obj as Record<string, unknown>;
    const hasTs = 'userEditedTimestampUsec' in o || 'createdTimestampUsec' in o;
    const hasNote = 'isTrashed' in o || 'textContent' in o || 'listContent' in o || 'title' in o;

    return hasTs && hasNote;
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
      if (path.extname(root).toLowerCase() === '.json') {
        files.push(root);
      }
    } else if (stat.isDirectory()) {
      for (const n of fs.readdirSync(root).sort((a, b) => a.localeCompare(b))) {
        if (path.extname(n).toLowerCase() === '.json') {
          files.push(path.join(root, n));
        }
      }
    }

    for (const fpath of files) {
      try {
        await this.processFile(fpath, params);
      } catch (e) {
        params.log?.('error', `Failed to import Keep note ${path.basename(fpath)}`, {
          error: (e as Error).message,
        });
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read Keep note ${path.basename(fpath)}`, {
        error: (e as Error).message,
      });

      return;
    }

    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    if (!raw.trim()) {
      return;
    }

    let note: KeepNote;
    try {
      note = JSON.parse(raw) as KeepNote;
    } catch {
      return;
    }

    if (!note || typeof note !== 'object') {
      return;
    }

    if (note.isTrashed) {
      return;
    } // skip trashed notes

    const ts = usecToDate(note.userEditedTimestampUsec) ?? usecToDate(note.createdTimestampUsec);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // A note's real content sometimes lives entirely in an annotation (e.g. a
    // shared Map place or web-link chip) with no textContent/listContent at
    // all — fall back to the annotation(s) so those notes don't import empty.
    const textBody = note.textContent?.trim() || '';
    const listBody = listToText(note.listContent);
    const hasOwnBody = !!(textBody || listBody);
    const body = textBody || listBody || annotationsToText(note.annotations);
    const title =
      note.title?.trim() ||
      '' ||
      (!hasOwnBody ? note.annotations?.[0]?.title?.trim() || '' : '') ||
      firstLine(body) ||
      'Keep note';
    const labels = (note.labels || []).map((l) => (l.name ?? '').trim()).filter(Boolean);

    // Stable id from the source filename — Takeout names each note file uniquely
    // (by its create-time + a content hash), so the basename is a natural key and
    // re-import is idempotent.
    params.pipeline.push({
      item: {
        id: 'keep:' + path.basename(fpath),
        classification: 'note',
        timestamp: ts,
        content: textContent('note.txt', body || title),
        metadata: {
          Title: title,
          Body: body || undefined,
          Labels: labels.length ? labels : undefined,
          Archived: !!note.isArchived,
          Pinned: note.isPinned ? true : undefined,
          Color: note.color && note.color !== 'DEFAULT' ? note.color : undefined,
          Source: 'Google Keep',
        },
      },
    });
  }
}

registerDataSource({
  name: 'google_keep',
  title: 'Google Keep',
  icon: '',
  description: 'Notes and checklists from a Google Takeout Keep export.',
  newFileImporter: () => new GoogleKeepFileImporter(),
});
