/* Snapchat — "My Data" export.
   Unzips to a folder of HTML plus a "json/" subfolder of JSON files
   (account_history.json, chat_history.json, snap_history.json,
   memories_history.json, ...). We import snap + chat records, each grouped
   into "Received ..." and "Sent ..." arrays.

   snap_history.json:
     { "Received Snap History": [ { "From": "user", "Media Type": "IMAGE", "Created": "2023-01-15 10:30:00 UTC" } ],
       "Sent Snap History":     [ { "To": "user",   "Media Type": "VIDEO", "Created": "..." } ] }
   chat_history.json:
     { "Received Chat History": [ { "From": "user", "Created": "...", "Text": "hi" } ],
       "Sent Chat History":     [ { "To": "user",   "Created": "...", "Text": "yo" } ] }
*/
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { filesIn } from './fsWalk';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

const SIGNATURE_FILES = ['snap_history.json', 'chat_history.json'];

interface SnapchatRecord {
  From?: string;
  To?: string;
  Created?: string;
  'Media Type'?: string;
  Text?: string;
}

// Parse Snapchat's "YYYY-MM-DD HH:MM:SS UTC" timestamp into a Date (treated as UTC).
function parseCreated(created: string | undefined): Date | undefined {
  if (!created) {
    return undefined;
  }

  const cleaned = created.replace(' UTC', '').trim();
  if (!cleaned) {
    return undefined;
  }

  // "YYYY-MM-DD HH:MM:SS" → ISO with explicit Z so it's interpreted as UTC.
  const iso = cleaned.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    const fallback = new Date(cleaned);

    return isNaN(fallback.getTime()) ? undefined : fallback;
  }

  return d;
}

function readJSON(fpath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(fpath, 'utf8');
  } catch {
    return undefined;
  }

  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Locate a signature file (snap_history.json / chat_history.json) inside a
// directory: check the root and a "json/" subfolder.
async function findSignatureFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const candidates = [root, path.join(root, 'json'), path.join(root, 'json_data')];
  for (const dir of candidates) {
    found.push(...(await filesIn(dir, (name) => SIGNATURE_FILES.includes(name.toLowerCase()))));
  }

  return found;
}

export class SnapchatFileImporter implements FileImporter {
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
      if (SIGNATURE_FILES.includes(base)) {
        return { confidence: 0.95 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      if ((await findSignatureFiles(root)).length > 0) {
        return { confidence: 0.95 };
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

    let files: string[] = [];
    if (stat.isFile()) {
      if (SIGNATURE_FILES.includes(path.basename(root).toLowerCase())) {
        files = [root];
      }
    } else if (stat.isDirectory()) {
      files = await findSignatureFiles(root);
    }

    for (const fpath of files) {
      this.processFile(fpath, params);
    }
  }

  private processFile(fpath: string, params: ImportParams): void {
    const base = path.basename(fpath).toLowerCase();
    let parsed: unknown;
    try {
      parsed = readJSON(fpath);
    } catch (e) {
      params.log?.('error', 'Failed to read Snapchat file', { file: base, error: (e as Error).message });

      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const isSnap = base === 'snap_history.json';
    const data = parsed as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      if (!Array.isArray(value)) {
        continue;
      }

      const direction = /received/i.test(key) ? 'Received' : /sent/i.test(key) ? 'Sent' : undefined;
      if (!direction) {
        continue;
      }

      value.forEach((rec, i) => {
        try {
          this.pushRecord(rec as SnapchatRecord, direction, isSnap, params, i);
        } catch (e) {
          params.log?.('error', 'Failed to import Snapchat record', {
            file: base,
            error: (e as Error).message,
          });
        }
      });
    }
  }

  private pushRecord(
    rec: SnapchatRecord,
    direction: 'Received' | 'Sent',
    isSnap: boolean,
    params: ImportParams,
    seq: number,
  ): void {
    if (!rec || typeof rec !== 'object') {
      return;
    }

    const ts = parseCreated(rec.Created);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const username = direction === 'Received' ? rec.From : rec.To;
    const text = typeof rec.Text === 'string' ? rec.Text : undefined;
    const iso = ts ? ts.toISOString() : 'no-ts';

    // Body text: chat text when present, else a short snap descriptor.
    const body =
      text ??
      (isSnap
        ? `${direction} ${rec['Media Type'] || 'snap'} ${direction === 'Received' ? 'from' : 'to'} ${username || 'unknown'}`
        : `${direction} chat ${direction === 'Received' ? 'from' : 'to'} ${username || 'unknown'}`);

    params.pipeline.push({
      item: {
        id: `snapchat:${isSnap ? 'snap' : 'chat'}:${direction}:${username || 'unknown'}:${iso}:${seq}`,
        classification: 'message',
        timestamp: ts,
        content: textContent('message.txt', body),
        metadata: {
          Direction: direction,
          // Without a title-bearing key, text-less snaps fall back to the
          // constant filename ('message.txt'); use the synthetic descriptor.
          Subject: text ? undefined : body,
          From: direction === 'Received' ? rec.From || undefined : undefined,
          To: direction === 'Sent' ? rec.To || undefined : undefined,
          'Media Type': isSnap ? rec['Media Type'] || undefined : undefined,
          Text: text,
          Source: 'Snapchat',
        },
      },
    });
  }
}

registerDataSource({
  name: 'snapchat',
  title: 'Snapchat',
  icon: '',
  description: 'Snap and chat history from a Snapchat data export.',
  newFileImporter: () => new SnapchatFileImporter(),
});
