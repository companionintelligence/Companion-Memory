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

   Current exports key both files by conversation instead: a friend's username,
   or an id for a group chat (which then carries a "Conversation Title"). Each
   record says who wrote it and whether you did:
     { "friend": [ { "From": "friend", "Media Type": "TEXT", "Created": "...",
                     "Content": "hi", "Conversation Title": null, "IsSender": false, ... } ] }
   The flag is spelled "IsSender" or "isSender" depending on the file, and
   snap_history.json records have no "Content".
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

// A record from the conversation-keyed layout.
interface ConversationRecord {
  From?: unknown;
  Created?: unknown;
  'Media Type'?: unknown;
  Content?: unknown;
  'Conversation Title'?: unknown;
  IsSender?: unknown;
  isSender?: unknown;
}

function senderFlag(rec: ConversationRecord): boolean | undefined {
  const flag = rec.IsSender ?? rec.isSender;

  return typeof flag === 'boolean' ? flag : undefined;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
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

      // Decided by the records, not the key: a username such as "absentee"
      // would otherwise read as a "Sent ..." array.
      if (
        value.some(
          (rec) => rec && typeof rec === 'object' && senderFlag(rec as ConversationRecord) !== undefined,
        )
      ) {
        this.processConversation(key, value, base, params);
        continue;
      }

      const direction = /received/i.test(key) ? 'Received' : /sent/i.test(key) ? 'Sent' : undefined;
      if (!direction) {
        value.forEach(() => params.pipeline.drop?.('snapchat_unknown_layout', base));
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

  /**
   * One conversation from the current layout. The key is the friend's username
   * for a direct chat and an opaque id for a group, which names itself in
   * "Conversation Title". A sent message to a group has no single recipient,
   * so it carries the group as its conversation and no To.
   */
  private processConversation(key: string, records: unknown[], base: string, params: ImportParams): void {
    const isSnap = base === 'snap_history.json';

    records.forEach((raw, i) => {
      const rec = raw as ConversationRecord;
      const isSender = rec && typeof rec === 'object' ? senderFlag(rec) : undefined;
      if (isSender === undefined) {
        params.pipeline.drop?.('snapchat_unknown_layout', base);

        return;
      }

      const title = nonEmpty(rec['Conversation Title']);
      const record: SnapchatRecord = {
        From: isSender ? undefined : nonEmpty(rec.From),
        To: isSender && !title ? key : undefined,
        Created: nonEmpty(rec.Created),
        'Media Type': nonEmpty(rec['Media Type']),
        Text: nonEmpty(rec.Content),
      };

      try {
        this.pushRecord(record, isSender ? 'Sent' : 'Received', isSnap, params, i, title ?? key);
      } catch (e) {
        params.log?.('error', 'Failed to import Snapchat record', {
          file: base,
          error: (e as Error).message,
        });
      }
    });
  }

  private pushRecord(
    rec: SnapchatRecord,
    direction: 'Received' | 'Sent',
    isSnap: boolean,
    params: ImportParams,
    seq: number,
    conversation?: string,
  ): void {
    if (!rec || typeof rec !== 'object') {
      return;
    }

    const ts = parseCreated(rec.Created);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const username = (direction === 'Received' ? rec.From : rec.To) || conversation;
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
          Conversation: conversation,
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
